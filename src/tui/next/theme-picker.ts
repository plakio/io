import {
	BoxRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { IoThemePreference } from "../../config.js";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoThemeOption {
	id: IoThemePreference;
	label: string;
	description: string;
}

export interface IoThemePickerOptions {
	renderer: CliRenderer;
	shell: IoShell;
	options: readonly IoThemeOption[];
	current: IoThemePreference;
	theme?: IoTheme;
	onPreview: (id: IoThemePreference) => void;
	onSelect: (id: IoThemePreference) => void;
	onClose?: () => void;
}

/** Theme picker with live preview; Esc leaves the last selected theme. */
export class IoThemePicker {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly options: readonly IoThemeOption[];
	private readonly theme: IoTheme;
	private readonly onPreview: (id: IoThemePreference) => void;
	private readonly onSelect: (id: IoThemePreference) => void;
	private readonly onClose: (() => void) | undefined;
	private panel: BoxRenderable | undefined;
	private list: ScrollBoxRenderable | undefined;
	private selected = 0;
	private opened = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoThemePickerOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.options = options.options;
		this.theme = options.theme ?? ioDarkTheme;
		this.onPreview = options.onPreview;
		this.onSelect = options.onSelect;
		this.onClose = options.onClose;
		const index = this.options.findIndex((option) => option.id === options.current);
		this.selected = index >= 0 ? index : 0;
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get selectedOption(): IoThemeOption | undefined {
		return this.options[this.selected];
	}

	open(): void {
		if (this.opened) return;
		this.opened = true;
		this.panel = this.buildPanel();
		this.shell.showOverlay(this.panel);
		this.renderer.keyInput.on("keypress", this.keyHandler);
		this.refresh();
		this.renderer.requestRender();
		const selected = this.selectedOption;
		if (selected) this.onPreview(selected.id);
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
		if (this.options.length === 0) return;
		this.selected = (this.selected + delta + this.options.length) % this.options.length;
		this.refresh();
		const selected = this.selectedOption;
		if (selected) this.onPreview(selected.id);
	}

	selectCurrent(): boolean {
		const option = this.selectedOption;
		if (!option) return false;
		this.onSelect(option.id);
		this.close();
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
			width: "62%",
			maxWidth: 72,
			height: "56%",
			maxHeight: 18,
			border: true,
			borderColor: this.theme.border,
			title: "Theme",
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
			content: "↑↓ preview · enter apply · esc close",
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
		for (const [index, option] of this.options.entries()) {
			const selected = index === this.selected;
			const select = () => {
				this.selected = index;
				this.refresh();
				this.onPreview(option.id);
				this.selectCurrent();
			};
			const label = new TextRenderable(this.renderer, {
				content: `${selected ? "›" : " "} ${option.label}`,
				fg: selected ? this.theme.accent : this.theme.text,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
			});
			label.onMouseDown = select;
			this.list.add(label);
			const description = new TextRenderable(this.renderer, {
				content: `   ${option.description}`,
				fg: this.theme.muted,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
				truncate: true,
			});
			description.onMouseDown = select;
			this.list.add(description);
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
