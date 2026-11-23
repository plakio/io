import {
	BoxRenderable,
	InputRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { AuthHost, AuthIntegration, AuthProvider } from "../../commands/next-auth.js";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoConnectDialogOptions {
	renderer: CliRenderer;
	shell: IoShell;
	cwd: string;
	createHost: () => Promise<AuthHost>;
	theme?: IoTheme;
	onClose?: () => void;
	onStatus?: (message: string) => void;
	onError?: (error: unknown) => void;
}

type Entry = {
	key: string;
	name: string;
	provider: AuthProvider;
	integration: AuthIntegration | undefined;
	configured: boolean;
	active: boolean;
};

type Mode = "list" | "oauth" | "code" | "key";

const POLL_INTERVAL = 1_000;
const POLL_LIMIT = 300;

/**
 * Single entry point for authentication. Lists integrations, connects OAuth or
 * API-key providers and removes stored credentials. There is deliberately no
 * separate /login or /logout command.
 */
export class IoConnectDialog {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly cwd: string;
	private readonly createHost: () => Promise<AuthHost>;
	private readonly theme: IoTheme;
	private readonly onClose: (() => void) | undefined;
	private readonly onStatus: ((message: string) => void) | undefined;
	private readonly onError: ((error: unknown) => void) | undefined;
	private host: AuthHost | undefined;
	private panel: BoxRenderable | undefined;
	private list: ScrollBoxRenderable | undefined;
	private status: TextRenderable | undefined;
	private input: InputRenderable | undefined;
	private hint: TextRenderable | undefined;
	private entries: readonly Entry[] = [];
	private selected = 0;
	private mode: Mode = "list";
	private opened = false;
	private polling: NodeJS.Timeout | undefined;
	private pendingOAuth: { integrationID: string; attemptID: string } | undefined;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoConnectDialogOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.cwd = options.cwd;
		this.createHost = options.createHost;
		this.theme = options.theme ?? ioDarkTheme;
		this.onClose = options.onClose;
		this.onStatus = options.onStatus;
		this.onError = options.onError;
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get selectedEntry(): Entry | undefined {
		return this.entries[this.selected];
	}

	async open(): Promise<void> {
		if (this.opened) return;
		this.opened = true;
		this.panel = this.buildPanel();
		this.shell.showOverlay(this.panel);
		this.renderer.keyInput.on("keypress", this.keyHandler);
		this.renderer.requestRender();
		await this.load();
	}

	close(): void {
		if (!this.opened) return;
		this.opened = false;
		this.stopPolling();
		void this.host?.close().catch(() => undefined);
		this.host = undefined;
		this.renderer.keyInput.off("keypress", this.keyHandler);
		this.input = undefined;
		this.list = undefined;
		this.status = undefined;
		this.hint = undefined;
		this.panel = undefined;
		this.shell.hideOverlay();
		this.onClose?.();
		this.renderer.requestRender();
	}

	dispose(): void {
		this.close();
	}

	move(delta: number): void {
		if (this.entries.length === 0) return;
		this.selected = (this.selected + delta + this.entries.length) % this.entries.length;
		this.renderList();
	}

	async connectSelected(): Promise<void> {
		const entry = this.selectedEntry;
		if (!entry) return;
		const oauth = entry.integration?.methods.find((method) => method.type === "oauth");
		if (!oauth || !this.host?.integration.oauth) {
			if (entry.integration?.methods.some((method) => method.type === "env")) {
				const env = entry.integration.methods.find((method) => method.type === "env");
				this.setStatus(`Set ${env?.names?.join(" or ") ?? "the provider environment variable"} and retry.`);
				return;
			}
			this.askForKey(entry);
			return;
		}
		try {
			const attempt = await this.host.integration.oauth.connect({
				integrationID: entry.key,
				methodID: oauth.id ?? "oauth",
				location: { directory: this.cwd },
			});
			this.pendingOAuth = { integrationID: entry.key, attemptID: attempt.data.attemptID };
			const instructions = attempt.data.instructions ? `\n${attempt.data.instructions}` : "";
			this.setStatus(`Open this URL to continue:\n${attempt.data.url}${instructions}`);
			if (attempt.data.mode === "code" || attempt.data.paste) {
				this.setMode("code");
				return;
			}
			this.setMode("oauth");
			this.pollOAuth();
		} catch (error) {
			this.fail(error);
		}
	}

	async disconnectSelected(): Promise<void> {
		const entry = this.selectedEntry;
		if (!entry || !this.host) return;
		const credentials = (await this.host.credential.list()).filter(
			(credential) => credential.integrationID === entry.key,
		);
		if (credentials.length === 0) {
			this.setStatus(`${entry.name} has no stored credentials.`);
			return;
		}
		try {
			for (const credential of credentials) await this.host.credential.remove({ credentialID: credential.id });
			this.onStatus?.(`Disconnected ${entry.name}`);
			await this.load();
			this.setStatus(`Removed ${credentials.length} credential${credentials.length === 1 ? "" : "s"} for ${entry.name}.`);
		} catch (error) {
			this.fail(error);
		}
	}

	private handleKey(event: IoKeyEvent): void {
		if (!this.opened || event.defaultPrevented) return;
		const name = event.name.toLowerCase();
		if (this.mode === "code" || this.mode === "key") {
			if (name === "escape") {
				this.cancelInput();
			} else {
				return;
			}
		} else if (this.mode === "oauth") {
			if (name === "escape") this.close();
			else return;
		} else if (name === "escape") this.close();
		else if (name === "up") this.move(-1);
		else if (name === "down") this.move(1);
		else if (name === "return") void this.connectSelected();
		else if (name === "d") void this.disconnectSelected();
		else if (name === "r") void this.load();
		else return;
		event.preventDefault?.();
		event.stopPropagation?.();
	}

	private buildPanel(): BoxRenderable {
		const panel = new BoxRenderable(this.renderer, {
			width: "78%",
			maxWidth: 96,
			height: "62%",
			maxHeight: 24,
			border: true,
			borderColor: this.theme.border,
			title: "Connect",
			titleColor: this.theme.accent,
			backgroundColor: this.theme.panel,
			padding: 1,
			flexDirection: "column",
			gap: 1,
		});
		const list = new ScrollBoxRenderable(this.renderer, {
			flexGrow: 1,
			flexShrink: 1,
			scrollY: true,
			backgroundColor: this.theme.panel,
			paddingX: 1,
		});
		const status = new TextRenderable(this.renderer, {
			content: "Loading providers…",
			fg: this.theme.muted,
			bg: this.theme.panel,
			wrapMode: "word",
		});
		const input = new InputRenderable(this.renderer, {
			value: "",
			placeholder: "Authorization code or API key",
			textColor: this.theme.text,
			backgroundColor: this.theme.panel,
			focusedBackgroundColor: this.theme.panel,
			focusedTextColor: this.theme.text,
			placeholderColor: this.theme.muted,
			visible: false,
		});
		input.onSubmit = () => void this.submitInput();
		const hint = new TextRenderable(this.renderer, {
			content: "↑↓ move · enter connect · d disconnect · r refresh · esc close",
			fg: this.theme.muted,
			bg: this.theme.panel,
			height: 1,
			wrapMode: "none",
			truncate: true,
		});
		panel.add(list);
		panel.add(status);
		panel.add(input);
		panel.add(hint);
		this.list = list;
		this.status = status;
		this.input = input;
		this.hint = hint;
		return panel;
	}

	private async load(): Promise<void> {
		try {
			this.host ??= await this.createHost();
			const [providers, integrations, credentials] = await Promise.all([
				this.host.provider.list({ location: { directory: this.cwd } }),
				this.host.integration.list({ location: { directory: this.cwd } }),
				this.host.credential.list(),
			]);
			const integrationByID = new Map(integrations.data.map((integration) => [integration.id, integration]));
			this.entries = providers.data.map((provider) => {
				const key = provider.integrationID ?? provider.id;
				const configured = credentials.some((credential) => credential.integrationID === key);
				return {
					key,
					name: provider.name,
					provider,
					integration: integrationByID.get(key),
					configured,
					active: credentials.some((credential) => credential.integrationID === key && credential.active),
				};
			});
			this.selected = Math.min(this.selected, Math.max(0, this.entries.length - 1));
			this.renderList();
			this.setStatus(
				this.entries.length === 0
					? "No providers available."
					: "Select a provider to connect, or press d on a configured one to disconnect.",
			);
		} catch (error) {
			this.fail(error);
		}
	}

	private renderList(): void {
		if (!this.list) return;
		clearChildren(this.list);
		if (this.entries.length === 0) {
			this.list.add(
				new TextRenderable(this.renderer, {
					content: "No providers",
					fg: this.theme.muted,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
				}),
			);
		}
		for (const [index, entry] of this.entries.entries()) {
			const selected = index === this.selected;
			const state = entry.active ? "● active" : entry.configured ? "● configured" : "○";
			const method = entry.integration?.methods.some((item) => item.type === "oauth")
				? "oauth"
				: entry.integration?.methods.some((item) => item.type === "env")
					? "env"
					: "key";
			this.list.add(
				new TextRenderable(this.renderer, {
					content: `${selected ? "›" : " "} ${entry.name.padEnd(28)} ${state}  ${method}`,
					fg: selected ? this.theme.accent : entry.configured ? this.theme.text : this.theme.muted,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
					truncate: true,
				}),
			);
		}
		this.renderer.requestRender();
	}

	private askForKey(entry: Entry): void {
		const input = this.input;
		if (!input) return;
		input.value = "";
		input.visible = true;
		input.placeholder = `API key for ${entry.name}`;
		this.setMode("key");
		this.setStatus(`Paste the API key for ${entry.name} and press Enter.`);
		input.focus();
	}

	private async submitInput(): Promise<void> {
		const value = this.input?.value.trim() ?? "";
		const entry = this.selectedEntry;
		if (!entry || !this.host) return;
		if (this.mode === "code" && this.pendingOAuth) {
			if (!value) return;
			try {
				await this.host.integration.oauth?.complete({
					integrationID: this.pendingOAuth.integrationID,
					attemptID: this.pendingOAuth.attemptID,
					code: value,
					location: { directory: this.cwd },
				});
				this.cancelInput();
				this.setMode("oauth");
				this.setStatus(`Authenticated with ${entry.name}.`);
				this.onStatus?.(`Connected ${entry.name}`);
				await this.load();
			} catch (error) {
				this.fail(error);
			}
			return;
		}
		if (this.mode === "key") {
			if (!value) return;
			try {
				await this.host.credential.create({
					integrationID: entry.key,
					label: "API key",
					value: { type: "key", key: value },
					activate: true,
				});
				this.cancelInput();
				this.onStatus?.(`Connected ${entry.name}`);
				await this.load();
				this.setStatus(`Stored API key for ${entry.name}.`);
			} catch (error) {
				this.fail(error);
			}
		}
	}

	private cancelInput(): void {
		if (this.input) {
			this.input.value = "";
			this.input.visible = false;
			this.input.blur();
		}
		this.setMode("list");
		this.setStatus("Select a provider to connect, or press d to disconnect.");
	}

	private setMode(mode: Mode): void {
		this.mode = mode;
		if (this.hint) {
			this.hint.content =
				mode === "list"
					? "↑↓ move · enter connect · d disconnect · r refresh · esc close"
					: mode === "oauth"
						? "waiting for authorization · esc close"
						: "enter submit · esc cancel";
		}
		this.renderer.requestRender();
	}

	private setStatus(message: string): void {
		if (this.status) this.status.content = message;
		this.renderer.requestRender();
	}

	private pollOAuth(): void {
		this.stopPolling();
		const pending = this.pendingOAuth;
		if (!pending || !this.host?.integration.oauth) return;
		let attempts = 0;
		this.polling = setInterval(() => {
			void (async () => {
				if (!this.host?.integration.oauth || !this.pendingOAuth) return;
				try {
					const status = await this.host.integration.oauth.status({
						integrationID: pending.integrationID,
						attemptID: pending.attemptID,
						location: { directory: this.cwd },
					});
					if (status.data.status === "complete") {
						this.stopPolling();
						this.pendingOAuth = undefined;
						const entry = this.entries.find((item) => item.key === pending.integrationID);
						this.onStatus?.(`Connected ${entry?.name ?? pending.integrationID}`);
						await this.load();
						this.setMode("list");
						this.setStatus(`Authenticated${entry ? ` with ${entry.name}` : ""}.`);
						return;
					}
					if (status.data.status === "failed" || status.data.status === "expired") {
						this.stopPolling();
						this.pendingOAuth = undefined;
						this.setMode("list");
						this.setStatus(`Authentication failed: ${status.data.message ?? status.data.status}`);
						return;
					}
					attempts += 1;
					if (attempts >= POLL_LIMIT) {
						this.stopPolling();
						this.pendingOAuth = undefined;
						this.setMode("list");
						this.setStatus("Authentication timed out.");
					}
				} catch (error) {
					this.stopPolling();
					this.fail(error);
				}
			})();
		}, POLL_INTERVAL);
		this.polling.unref?.();
	}

	private stopPolling(): void {
		if (this.polling !== undefined) clearInterval(this.polling);
		this.polling = undefined;
	}

	private fail(error: unknown): void {
		const message = String((error as Error).message ?? error);
		this.setStatus(message);
		this.onError?.(error);
	}
}

function clearChildren(container: { getChildren(): readonly { destroyRecursively(): void }[]; remove(child: never): void }): void {
	for (const child of [...container.getChildren()]) {
		container.remove(child as never);
		child.destroyRecursively();
	}
}
