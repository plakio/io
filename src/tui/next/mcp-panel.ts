import {
	BoxRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { EngineMcpServer } from "../../engine/types.js";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoMcpPanelOptions {
	renderer: CliRenderer;
	shell: IoShell;
	load: () => Promise<readonly EngineMcpServer[]>;
	onConnect: (server: EngineMcpServer) => Promise<void> | void;
	onDisconnect: (server: EngineMcpServer) => Promise<void> | void;
	theme?: IoTheme;
	onClose?: () => void;
	onError?: (error: unknown) => void;
}

/** MCP server list with reconnect/disconnect controls. */
export class IoMcpPanel {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly load: () => Promise<readonly EngineMcpServer[]>;
	private readonly onConnect: IoMcpPanelOptions["onConnect"];
	private readonly onDisconnect: IoMcpPanelOptions["onDisconnect"];
	private readonly theme: IoTheme;
	private readonly onClose: (() => void) | undefined;
	private readonly onError: ((error: unknown) => void) | undefined;
	private panel: BoxRenderable | undefined;
	private list: ScrollBoxRenderable | undefined;
	private status: TextRenderable | undefined;
	private servers: readonly EngineMcpServer[] = [];
	private selected = 0;
	private opened = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoMcpPanelOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.load = options.load;
		this.onConnect = options.onConnect;
		this.onDisconnect = options.onDisconnect;
		this.theme = options.theme ?? ioDarkTheme;
		this.onClose = options.onClose;
		this.onError = options.onError;
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get selectedServer(): EngineMcpServer | undefined {
		return this.servers[this.selected];
	}

	async open(): Promise<void> {
		if (this.opened) return;
		this.opened = true;
		this.panel = this.buildPanel();
		this.shell.showOverlay(this.panel);
		this.renderer.keyInput.on("keypress", this.keyHandler);
		this.renderer.requestRender();
		await this.refresh();
	}

	close(): void {
		if (!this.opened) return;
		this.opened = false;
		this.renderer.keyInput.off("keypress", this.keyHandler);
		this.list = undefined;
		this.status = undefined;
		this.panel = undefined;
		this.shell.hideOverlay();
		this.onClose?.();
		this.renderer.requestRender();
	}

	move(delta: number): void {
		if (this.servers.length === 0) return;
		this.selected = (this.selected + delta + this.servers.length) % this.servers.length;
		this.refreshRows();
	}

	async connectSelected(): Promise<void> {
		const server = this.selectedServer;
		if (!server) return;
		try {
			await this.onConnect(server);
			this.setStatus(`connected ${server.name}`);
			await this.refresh();
		} catch (error) {
			this.fail(error);
		}
	}

	async disconnectSelected(): Promise<void> {
		const server = this.selectedServer;
		if (!server) return;
		try {
			await this.onDisconnect(server);
			this.setStatus(`disconnected ${server.name}`);
			await this.refresh();
		} catch (error) {
			this.fail(error);
		}
	}

	async refresh(): Promise<void> {
		try {
			this.servers = await this.load();
			this.selected = Math.min(this.selected, Math.max(0, this.servers.length - 1));
			this.refreshRows();
			this.setStatus(this.servers.length === 0 ? "No MCP servers configured" : "enter connect · d disconnect · r refresh");
		} catch (error) {
			this.fail(error);
		}
	}

	dispose(): void {
		this.close();
	}

	private handleKey(event: IoKeyEvent): void {
		if (!this.opened || event.defaultPrevented) return;
		const name = event.name.toLowerCase();
		if (name === "escape" || name === "q") this.close();
		else if (name === "up") this.move(-1);
		else if (name === "down") this.move(1);
		else if (name === "return") void this.connectSelected();
		else if (name === "d") void this.disconnectSelected();
		else if (name === "r") void this.refresh();
		else return;
		event.preventDefault?.();
		event.stopPropagation?.();
	}

	private buildPanel(): BoxRenderable {
		const panel = new BoxRenderable(this.renderer, {
			width: "70%",
			maxWidth: 90,
			height: "56%",
			maxHeight: 20,
			border: true,
			borderColor: this.theme.border,
			title: "MCP",
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
			content: "Loading…",
			fg: this.theme.muted,
			bg: this.theme.panel,
			wrapMode: "word",
		});
		panel.add(list);
		panel.add(status);
		this.list = list;
		this.status = status;
		return panel;
	}

	private refreshRows(): void {
		if (!this.list) return;
		clearChildren(this.list);
		for (const [index, server] of this.servers.entries()) {
			const selected = index === this.selected;
			const color =
				server.status === "connected"
					? this.theme.success
					: server.status === "failed" || server.status === "needs_auth"
						? this.theme.error
						: this.theme.warning;
			const row = new TextRenderable(this.renderer, {
				content: `${selected ? "›" : " "} ${server.title ?? server.name}  ${server.status}`,
				fg: selected ? this.theme.accent : color,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
				truncate: true,
			});
			row.onMouseDown = () => {
				this.selected = index;
				this.refreshRows();
				void this.connectSelected();
			};
			this.list.add(row);
		}
		this.renderer.requestRender();
	}

	private setStatus(message: string): void {
		if (this.status) this.status.content = message;
		this.renderer.requestRender();
	}

	private fail(error: unknown): void {
		this.setStatus(String((error as Error).message ?? error));
		this.onError?.(error);
	}
}

function clearChildren(container: { getChildren(): readonly { destroyRecursively(): void }[]; remove(child: never): void }): void {
	for (const child of [...container.getChildren()]) {
		container.remove(child as never);
		child.destroyRecursively();
	}
}
