import {
	BoxRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoStatusPanelOptions {
	renderer: CliRenderer;
	shell: IoShell;
	load: () => Promise<readonly string[]>;
	theme?: IoTheme;
	onClose?: () => void;
	onError?: (error: unknown) => void;
}

/** Read-only status sheet: session, model, context and engine state. */
export class IoStatusPanel {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly load: () => Promise<readonly string[]>;
	private readonly theme: IoTheme;
	private readonly onClose: (() => void) | undefined;
	private readonly onError: ((error: unknown) => void) | undefined;
	private panel: BoxRenderable | undefined;
	private list: ScrollBoxRenderable | undefined;
	private opened = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoStatusPanelOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.load = options.load;
		this.theme = options.theme ?? ioDarkTheme;
		this.onClose = options.onClose;
		this.onError = options.onError;
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
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
		this.panel = undefined;
		this.shell.hideOverlay();
		this.onClose?.();
		this.renderer.requestRender();
	}

	dispose(): void {
		this.close();
	}

	async refresh(): Promise<void> {
		try {
			const lines = await this.load();
			this.render(lines);
		} catch (error) {
			this.onError?.(error);
			this.render([String((error as Error).message ?? error)]);
		}
	}

	private handleKey(event: IoKeyEvent): void {
		if (!this.opened || event.defaultPrevented) return;
		const name = event.name.toLowerCase();
		if (name === "escape" || name === "q") this.close();
		else if (name === "r") void this.refresh();
		else return;
		event.preventDefault?.();
		event.stopPropagation?.();
	}

	private buildPanel(): BoxRenderable {
		const panel = new BoxRenderable(this.renderer, {
			width: "72%",
			maxWidth: 92,
			height: "62%",
			maxHeight: 24,
			border: true,
			borderColor: this.theme.border,
			title: "Status",
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
		const hint = new TextRenderable(this.renderer, {
			content: "r refresh · esc close",
			fg: this.theme.muted,
			bg: this.theme.panel,
			height: 1,
			wrapMode: "none",
		});
		panel.add(list);
		panel.add(hint);
		this.list = list;
		return panel;
	}

	private render(lines: readonly string[]): void {
		if (!this.list) return;
		clearChildren(this.list);
		if (lines.length === 0) {
			this.list.add(
				new TextRenderable(this.renderer, {
					content: "No status",
					fg: this.theme.muted,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
				}),
			);
		}
		for (const line of lines) {
			this.list.add(
				new TextRenderable(this.renderer, {
					content: line,
					fg: line.startsWith(" ") ? this.theme.muted : this.theme.text,
					bg: this.theme.panel,
					wrapMode: "word",
				}),
			);
		}
		this.renderer.requestRender();
	}
}

function clearChildren(container: { getChildren(): readonly { destroyRecursively(): void }[]; remove(child: never): void }): void {
	for (const child of [...container.getChildren()]) {
		container.remove(child as never);
		child.destroyRecursively();
	}
}
