import {
	BoxRenderable,
	ImageRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import { basename } from "node:path";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoImagePanelOptions {
	renderer: CliRenderer;
	shell: IoShell;
	theme?: IoTheme;
	onClose?: () => void;
}

/** Full-screen image preview with terminal protocol fallback. */
export class IoImagePanel {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly theme: IoTheme;
	private readonly onClose: (() => void) | undefined;
	private opened = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoImagePanelOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.theme = options.theme ?? ioDarkTheme;
		this.onClose = options.onClose;
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	open(path: string): void {
		if (this.opened) this.close();
		this.opened = true;
		const panel = new BoxRenderable(this.renderer, {
			width: "92%",
			height: "92%",
			border: true,
			borderColor: this.theme.border,
			title: `Preview · ${basename(path)}`,
			titleColor: this.theme.accent,
			backgroundColor: this.theme.background,
			flexDirection: "column",
			padding: 1,
		});
		const image = new ImageRenderable(this.renderer, {
			source: path,
			fit: "fit",
			flexGrow: 1,
		});
		const hint = new TextRenderable(this.renderer, {
			content: "esc close",
			fg: this.theme.muted,
			bg: this.theme.background,
			height: 1,
			wrapMode: "none",
		});
		panel.add(image);
		panel.add(hint);
		this.shell.showOverlay(panel);
		this.renderer.keyInput.on("keypress", this.keyHandler);
		this.renderer.requestRender();
	}

	close(): void {
		if (!this.opened) return;
		this.opened = false;
		this.renderer.keyInput.off("keypress", this.keyHandler);
		this.shell.hideOverlay();
		this.onClose?.();
		this.renderer.requestRender();
	}

	dispose(): void {
		this.close();
	}

	private handleKey(event: IoKeyEvent): void {
		if (!this.opened || event.defaultPrevented) return;
		const name = event.name.toLowerCase();
		if (name !== "escape" && name !== "q") return;
		event.preventDefault?.();
		event.stopPropagation?.();
		this.close();
	}
}
