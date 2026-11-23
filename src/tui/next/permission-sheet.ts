import {
	BoxRenderable,
	InputRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { EnginePermissionRequest, PermissionDecision } from "../../engine/types.js";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoPermissionSheetOptions {
	renderer: CliRenderer;
	shell: IoShell;
	theme?: IoTheme;
	/** Ring the terminal bell when a request arrives. Default true. */
	bell?: boolean;
	onDecision: (decision: PermissionDecision, message?: string) => void | Promise<void>;
	onClose?: () => void;
	onError?: (error: unknown) => void;
}

const DECISIONS: readonly PermissionDecision[] = ["once", "always", "reject"];
const LABELS: Record<PermissionDecision, string> = {
	once: "Allow once",
	always: "Always allow",
	reject: "Reject",
};

/** Approval sheet. The default choice is Reject. */
export class IoPermissionSheet {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly theme: IoTheme;
	private readonly callbacks: Pick<IoPermissionSheetOptions, "onDecision" | "onClose" | "onError">;
	private readonly bell: boolean;
	private panel: BoxRenderable | undefined;
	private feedbackBox: BoxRenderable | undefined;
	private feedbackInput: InputRenderable | undefined;
	private request: EnginePermissionRequest | undefined;
	private selected = 2;
	private opened = false;
	private feedbackMode = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoPermissionSheetOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.theme = options.theme ?? ioDarkTheme;
		this.bell = options.bell !== false;
		this.callbacks = options;
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get selectedDecision(): PermissionDecision {
		return DECISIONS[this.selected] ?? "reject";
	}

	get currentRequest(): EnginePermissionRequest | undefined {
		return this.request;
	}

	open(request: EnginePermissionRequest): void {
		if (this.opened) this.hide();
		this.request = request;
		this.selected = DECISIONS.indexOf("reject");
		this.feedbackMode = false;
		this.opened = true;
		this.panel = this.buildPanel();
		this.shell.showOverlay(this.panel);
		this.renderer.keyInput.on("keypress", this.keyHandler);
		this.renderer.requestRender();
		if (this.bell) this.ringBell();
	}

	close(): void {
		if (!this.opened) return;
		this.opened = false;
		this.feedbackMode = false;
		this.renderer.keyInput.off("keypress", this.keyHandler);
		this.panel = undefined;
		this.feedbackBox = undefined;
		this.feedbackInput = undefined;
		this.request = undefined;
		this.shell.hideOverlay();
		this.callbacks.onClose?.();
		this.renderer.requestRender();
	}

	move(delta: number): void {
		if (this.feedbackMode) return;
		this.selected = (this.selected + delta + DECISIONS.length) % DECISIONS.length;
		this.refresh();
	}

	selectCurrent(): boolean {
		if (this.feedbackMode) return false;
		void this.decide(this.selectedDecision);
		return true;
	}

	async decide(decision: PermissionDecision, message?: string): Promise<void> {
		if (!this.opened) return;
		const request = this.request;
		if (!request) return;
		this.close();
		try {
			await this.callbacks.onDecision(decision, message);
		} catch (error) {
			this.callbacks.onError?.(error);
		}
	}

	startFeedback(): boolean {
		if (!this.feedbackBox || !this.feedbackInput) return false;
		this.feedbackMode = true;
		this.feedbackBox.visible = true;
		this.feedbackInput.value = "";
		this.feedbackInput.focus();
		this.renderer.requestRender();
		return true;
	}

	setFeedback(value: string): void {
		if (this.feedbackInput) this.feedbackInput.value = value;
	}

	async commitFeedback(): Promise<boolean> {
		if (!this.feedbackMode) return false;
		const message = this.feedbackInput?.value.trim();
		await this.decide("reject", message || undefined);
		return true;
	}

	cancelFeedback(): void {
		if (!this.feedbackBox) return;
		this.feedbackMode = false;
		this.feedbackBox.visible = false;
		this.renderer.requestRender();
	}

	dispose(): void {
		this.close();
	}

	private handleKey(event: IoKeyEvent): void {
		if (!this.opened || event.defaultPrevented) return;
		const name = event.name.toLowerCase();
		if (this.feedbackMode) {
			if (name === "escape") this.cancelFeedback();
			else if (name === "return") void this.commitFeedback();
			else return;
			event.preventDefault?.();
			event.stopPropagation?.();
			return;
		}
		if (name === "escape") void this.decide("reject");
		else if (name === "up") this.move(-1);
		else if (name === "down") this.move(1);
		else if (name === "return") this.selectCurrent();
		else if (event.ctrl && name === "r") this.startFeedback();
		else return;
		event.preventDefault?.();
		event.stopPropagation?.();
	}

	private buildPanel(): BoxRenderable {
		const request = this.request;
		const panel = new BoxRenderable(this.renderer, {
			width: "78%",
			maxWidth: 90,
			height: "64%",
			maxHeight: 26,
			border: true,
			borderColor: this.theme.warning,
			title: "Permission required",
			titleColor: this.theme.warning,
			backgroundColor: this.theme.panel,
			padding: 1,
			flexDirection: "column",
			gap: 1,
		});
		panel.add(
			new TextRenderable(this.renderer, {
				content: `${request?.action ?? "action"} requests access`,
				fg: this.theme.text,
				bg: this.theme.panel,
				wrapMode: "word",
			}),
		);
		if (request?.resources.length) {
			panel.add(
				new TextRenderable(this.renderer, {
					content: request.resources.map((resource) => `  ${resource}`).join("\n"),
					fg: this.theme.text,
					bg: this.theme.panel,
					wrapMode: "word",
				}),
			);
		}
		if (request?.message) {
			panel.add(
				new TextRenderable(this.renderer, {
					content: request.message,
					fg: this.theme.muted,
					bg: this.theme.panel,
					wrapMode: "word",
				}),
			);
		}
		const options = new TextRenderable(this.renderer, {
			content: optionsText(this.selected),
			fg: this.theme.text,
			bg: this.theme.panel,
			wrapMode: "none",
		});
		options.id = "io-permission-options";
		panel.add(options);
		const feedbackBox = new BoxRenderable(this.renderer, {
			flexDirection: "column",
			visible: false,
			backgroundColor: this.theme.panel,
		});
		const feedbackInput = new InputRenderable(this.renderer, {
			value: "",
			placeholder: "Feedback for the agent (optional)…",
			textColor: this.theme.text,
			backgroundColor: this.theme.panel,
			focusedBackgroundColor: this.theme.panel,
			focusedTextColor: this.theme.text,
			placeholderColor: this.theme.muted,
		});
		feedbackBox.add(feedbackInput);
		feedbackBox.add(
			new TextRenderable(this.renderer, {
				content: "enter send · esc back",
				fg: this.theme.muted,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
			}),
		);
		panel.add(feedbackBox);
		panel.add(
			new TextRenderable(this.renderer, {
				content: "↑↓ choose · enter confirm · esc reject · ctrl+r reject with feedback",
				fg: this.theme.muted,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
				truncate: true,
			}),
		);
		this.feedbackBox = feedbackBox;
		this.feedbackInput = feedbackInput;
		return panel;
	}

	private refresh(): void {
		const options = this.panel?.findDescendantById("io-permission-options");
		if (options instanceof TextRenderable) options.content = optionsText(this.selected);
		this.renderer.requestRender();
	}

	private ringBell(): void {
		if (!process.stdout.isTTY) return;
		try {
			process.stdout.write("\x07");
		} catch {
			// A closed stdout is handled elsewhere.
		}
	}

	private hide(): void {
		this.close();
	}
}

function optionsText(selected: number): string {
	return DECISIONS.map((decision, index) => `${index === selected ? "›" : " "} ${LABELS[decision]}`).join("\n");
}
