import {
	BoxRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoErrorPanelOptions {
	renderer: CliRenderer;
	shell: IoShell;
	theme?: IoTheme;
	onClose?: () => void;
}

/** Full error details with OSC52 copy, instead of a truncated toast. */
export class IoErrorPanel {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly theme: IoTheme;
	private readonly onClose: (() => void) | undefined;
	private panel: BoxRenderable | undefined;
	private message = "";
	private opened = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoErrorPanelOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.theme = options.theme ?? ioDarkTheme;
		this.onClose = options.onClose;
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	open(message: string): void {
		if (this.opened) this.close();
		this.opened = true;
		this.message = message;
		this.panel = this.buildPanel();
		this.shell.showOverlay(this.panel);
		this.renderer.keyInput.on("keypress", this.keyHandler);
		this.renderer.requestRender();
	}

	close(): void {
		if (!this.opened) return;
		this.opened = false;
		this.renderer.keyInput.off("keypress", this.keyHandler);
		this.panel = undefined;
		this.shell.hideOverlay();
		this.onClose?.();
		this.renderer.requestRender();
	}

	copy(): boolean {
		try {
			return this.renderer.copyToClipboardOSC52(this.message);
		} catch {
			return false;
		}
	}

	dispose(): void {
		this.close();
	}

	private handleKey(event: IoKeyEvent): void {
		if (!this.opened || event.defaultPrevented) return;
		const name = event.name.toLowerCase();
		if (name === "escape" || name === "q") this.close();
		else if (name === "y") this.copy();
		else return;
		event.preventDefault?.();
		event.stopPropagation?.();
	}

	private buildPanel(): BoxRenderable {
		const panel = new BoxRenderable(this.renderer, {
			width: "78%",
			maxWidth: 100,
			height: "62%",
			maxHeight: 24,
			border: true,
			borderColor: this.theme.error,
			title: "Error",
			titleColor: this.theme.error,
			backgroundColor: this.theme.panel,
			padding: 1,
			flexDirection: "column",
			gap: 1,
		});
		const scroll = new ScrollBoxRenderable(this.renderer, {
			flexGrow: 1,
			flexShrink: 1,
			scrollY: true,
			backgroundColor: this.theme.panel,
			paddingX: 1,
		});
		const body = new TextRenderable(this.renderer, {
			content: this.message,
			fg: this.theme.text,
			bg: this.theme.panel,
			wrapMode: "word",
		});
		scroll.add(body);
		const hint = new TextRenderable(this.renderer, {
			content: "y copy · esc close",
			fg: this.theme.muted,
			bg: this.theme.panel,
			height: 1,
			wrapMode: "none",
		});
		panel.add(scroll);
		panel.add(hint);
		return panel;
	}
}
