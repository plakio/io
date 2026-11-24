import {
	BoxRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoSettingRow {
	id: string;
	label: string;
	value: string;
}

export interface IoSettingsPanelOptions {
	renderer: CliRenderer;
	shell: IoShell;
	rows: readonly IoSettingRow[];
	theme?: IoTheme;
	onActivate: (id: string) => void;
	onClose?: () => void;
}

/** Compact settings sheet: enter cycles the selected preference. */
export class IoSettingsPanel {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly theme: IoTheme;
	private readonly onActivate: (id: string) => void;
	private readonly onClose: (() => void) | undefined;
	private rows: readonly IoSettingRow[];
	private panel: BoxRenderable | undefined;
	private list: ScrollBoxRenderable | undefined;
	private selected = 0;
	private opened = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoSettingsPanelOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.theme = options.theme ?? ioDarkTheme;
		this.rows = options.rows;
		this.onActivate = options.onActivate;
		this.onClose = options.onClose;
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get selectedRow(): IoSettingRow | undefined {
		return this.rows[this.selected];
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

	setRows(rows: readonly IoSettingRow[]): void {
		this.rows = rows;
		this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
		this.refresh();
	}

	move(delta: number): void {
		if (this.rows.length === 0) return;
		this.selected = (this.selected + delta + this.rows.length) % this.rows.length;
		this.refresh();
	}

	activate(): boolean {
		const row = this.selectedRow;
		if (!row) return false;
		this.onActivate(row.id);
		return true;
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
		else if (name === "return" || name === "space") this.activate();
		else return;
		event.preventDefault?.();
		event.stopPropagation?.();
	}

	private buildPanel(): BoxRenderable {
		const panel = new BoxRenderable(this.renderer, {
			width: "64%",
			maxWidth: 76,
			height: "58%",
			maxHeight: 20,
			border: true,
			borderColor: this.theme.border,
			title: "Settings",
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
			content: "↑↓ move · enter cycle · esc close",
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
		for (const [index, row] of this.rows.entries()) {
			const selected = index === this.selected;
			const label = row.label.padEnd(16);
			const text = new TextRenderable(this.renderer, {
				content: `${selected ? "›" : " "} ${label} ${row.value}`,
				fg: selected ? this.theme.accent : this.theme.text,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
			});
			text.onMouseDown = () => {
				this.selected = index;
				this.refresh();
				this.activate();
			};
			this.list.add(text);
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
