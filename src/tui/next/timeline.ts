import {
	BoxRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoTimelineOptions {
	renderer: CliRenderer;
	shell: IoShell;
	entries: readonly string[];
	theme?: IoTheme;
	onSelect: (index: number) => void;
	onClose?: () => void;
}

/** User-message timeline: jump the transcript to an earlier turn. */
export class IoTimeline {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly entries: readonly string[];
	private readonly theme: IoTheme;
	private readonly onSelect: (index: number) => void;
	private readonly onClose: (() => void) | undefined;
	private panel: BoxRenderable | undefined;
	private list: ScrollBoxRenderable | undefined;
	private selected = 0;
	private opened = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoTimelineOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.entries = options.entries;
		this.theme = options.theme ?? ioDarkTheme;
		this.onSelect = options.onSelect;
		this.onClose = options.onClose;
		this.selected = Math.max(0, this.entries.length - 1);
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get selectedIndex(): number {
		return this.selected;
	}

	open(): void {
		if (this.opened) return;
		this.opened = true;
		this.panel = this.buildPanel();
		this.shell.showOverlay(this.panel);
		this.renderer.keyInput.on("keypress", this.keyHandler);
		this.refresh();
		this.renderer.requestRender();
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

	move(delta: number): void {
		if (this.entries.length === 0) return;
		this.selected = (this.selected + delta + this.entries.length) % this.entries.length;
		this.refresh();
	}

	selectCurrent(): boolean {
		if (this.entries.length === 0) return false;
		const index = this.selected;
		this.close();
		this.onSelect(index);
		return true;
	}

	dispose(): void {
		this.close();
	}

	private handleKey(event: IoKeyEvent): void {
		if (!this.opened || event.defaultPrevented) return;
		const name = event.name.toLowerCase();
		if (name === "escape") this.close();
		else if (name === "up") this.move(-1);
		else if (name === "down") this.move(1);
		else if (name === "return") this.selectCurrent();
		else return;
		event.preventDefault?.();
		event.stopPropagation?.();
	}

	private buildPanel(): BoxRenderable {
		const panel = new BoxRenderable(this.renderer, {
			width: "70%",
			maxWidth: 90,
			height: "58%",
			maxHeight: 20,
			border: true,
			borderColor: this.theme.border,
			title: "Timeline",
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
			content: "↑↓ move · enter jump · esc close",
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

	private refresh(): void {
		if (!this.list) return;
		clearChildren(this.list);
		if (this.entries.length === 0) {
			this.list.add(
				new TextRenderable(this.renderer, {
					content: "No user messages",
					fg: this.theme.muted,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
				}),
			);
		}
		for (const [index, entry] of this.entries.entries()) {
			const selected = index === this.selected;
			const row = new TextRenderable(this.renderer, {
				content: `${selected ? "›" : " "} ${index + 1}. ${entry.replace(/\s+/g, " ").trim()}`,
				fg: selected ? this.theme.accent : this.theme.text,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
				truncate: true,
			});
			row.onMouseDown = () => {
				this.selected = index;
				this.refresh();
				this.selectCurrent();
			};
			this.list.add(row);
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
