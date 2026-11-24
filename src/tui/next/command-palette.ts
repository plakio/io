import {
	BoxRenderable,
	InputRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { IoCommand, IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoCommandPaletteOptions {
	renderer: CliRenderer;
	shell: IoShell;
	commands: readonly IoCommand[];
	theme?: IoTheme;
	onClose?: () => void;
	onError?: (error: unknown) => void;
}

/** Command palette: filter with the input, move with arrows, run with Enter. */
export class IoCommandPalette {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly commands: readonly IoCommand[];
	private readonly theme: IoTheme;
	private readonly onClose: (() => void) | undefined;
	private readonly onError: ((error: unknown) => void) | undefined;
	private panel: BoxRenderable | undefined;
	private input: InputRenderable | undefined;
	private list: ScrollBoxRenderable | undefined;
	private visible: readonly IoCommand[] = [];
	private selected = 0;
	private opened = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoCommandPaletteOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.commands = options.commands;
		this.theme = options.theme ?? ioDarkTheme;
		this.onClose = options.onClose;
		this.onError = options.onError;
		this.keyHandler = (event) => {
			if (!this.opened || event.defaultPrevented) return;
			const name = event.name.toLowerCase();
			let handled = true;
			if (name === "escape") this.close();
			else if (name === "up") this.move(-1);
			else if (name === "down") this.move(1);
			else if (name === "return") this.executeSelected();
			else handled = false;
			if (!handled) return;
			event.preventDefault?.();
			event.stopPropagation?.();
		};
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get selectedCommand(): IoCommand | undefined {
		return this.visible[this.selected];
	}

	open(): void {
		if (this.opened) return;
		this.opened = true;
		this.visible = this.commands;
		this.selected = 0;
		this.panel = this.buildPanel();
		this.shell.showOverlay(this.panel);
		this.input?.focus();
		this.renderer.keyInput.on("keypress", this.keyHandler);
		this.refresh();
		this.renderer.requestRender();
	}

	close(): void {
		if (!this.opened) return;
		this.opened = false;
		this.renderer.keyInput.off("keypress", this.keyHandler);
		this.input = undefined;
		this.list = undefined;
		this.panel = undefined;
		this.shell.hideOverlay();
		this.onClose?.();
		this.renderer.requestRender();
	}

	setQuery(query: string): void {
		if (!this.input) return;
		this.input.value = query;
		this.refresh();
	}

	move(delta: number): void {
		if (this.visible.length === 0) return;
		this.selected = (this.selected + delta + this.visible.length) % this.visible.length;
		this.refresh();
	}

	executeSelected(): boolean {
		const command = this.selectedCommand;
		if (!command) return false;
		this.close();
		try {
			const result = command.run();
			if (result && typeof (result as Promise<void>).catch === "function") {
				(result as Promise<void>).catch((error) => this.onError?.(error));
			}
			return true;
		} catch (error) {
			this.onError?.(error);
			return false;
		}
	}

	dispose(): void {
		this.close();
	}

	private buildPanel(): BoxRenderable {
		const panel = new BoxRenderable(this.renderer, {
			width: "78%",
			maxWidth: 90,
			height: "62%",
			maxHeight: 24,
			border: true,
			borderColor: this.theme.border,
			title: "Commands",
			titleColor: this.theme.accent,
			backgroundColor: this.theme.panel,
			padding: 1,
			flexDirection: "column",
			gap: 1,
		});
		const input = new InputRenderable(this.renderer, {
			value: "",
			placeholder: "Search commands…",
			textColor: this.theme.text,
			backgroundColor: this.theme.panel,
			focusedBackgroundColor: this.theme.panel,
			focusedTextColor: this.theme.text,
			placeholderColor: this.theme.muted,
		});
		input.onContentChange = () => this.refresh();
		const list = new ScrollBoxRenderable(this.renderer, {
			flexGrow: 1,
			flexShrink: 1,
			scrollY: true,
			backgroundColor: this.theme.panel,
			paddingX: 1,
		});
		const hint = new TextRenderable(this.renderer, {
			content: "↑↓ move · enter run · esc close",
			fg: this.theme.muted,
			bg: this.theme.panel,
			height: 1,
			wrapMode: "none",
		});
		panel.add(input);
		panel.add(list);
		panel.add(hint);
		this.input = input;
		this.list = list;
		return panel;
	}

	private refresh(): void {
		if (!this.input || !this.list) return;
		const query = this.input.value.trim().toLowerCase();
		const matches = this.commands
			.map((command) => ({ command, score: matchScore(command, query) }))
			.filter((entry) => entry.score !== undefined)
			.sort((left, right) => (left.score ?? 0) - (right.score ?? 0) || left.command.title.localeCompare(right.command.title))
			.map((entry) => entry.command);
		const ordered = query.length > 0 ? matches : orderForPalette(matches);
		this.visible = ordered;
		this.selected = Math.min(this.selected, Math.max(0, ordered.length - 1));
		clearChildren(this.list);
		if (ordered.length === 0) {
			this.list.add(
				new TextRenderable(this.renderer, {
					content: "No commands",
					fg: this.theme.muted,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
				}),
			);
		} else {
			let section = "";
			ordered.slice(0, 60).forEach((command, index) => {
				const nextSection = query.length > 0 ? "" : command.suggested ? "Suggested" : (command.group ?? "Other");
				if (nextSection && nextSection !== section) {
					section = nextSection;
					this.list?.add(
						new TextRenderable(this.renderer, {
							content: section,
							fg: this.theme.accent,
							bg: this.theme.panel,
							height: 1,
							wrapMode: "none",
						}),
					);
				}
				this.list?.add(this.commandRow(command, index));
			});
		}
		try {
			this.list.scrollTo(0);
		} catch {
			// Layout may not be ready during the first refresh.
		}
		this.renderer.requestRender();
	}

	private commandRow(command: IoCommand, index: number): BoxRenderable {
		const selected = index === this.selected;
		const row = new BoxRenderable(this.renderer, {
			id: `palette-${index}`,
			flexDirection: "row",
			height: 1,
			backgroundColor: this.theme.panel,
		});
		row.add(
			new TextRenderable(this.renderer, {
				content: `${selected ? "›" : " "} ${command.title}`,
				fg: selected ? this.theme.accent : this.theme.text,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
				flexShrink: 0,
			}),
		);
		if (command.description) {
			row.add(
				new TextRenderable(this.renderer, {
					content: `  ${command.description}`,
					fg: this.theme.muted,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
					truncate: true,
					flexShrink: 1,
				}),
			);
		}
		row.onMouseDown = () => {
			this.selected = index;
			this.refresh();
			this.executeSelected();
		};
		row.add(new BoxRenderable(this.renderer, { flexGrow: 1, height: 1 }));
		const keys = command.keys?.map((key) => key.replace(/^<leader>/, "ctrl+x ").replace(/^leader\+/, "ctrl+x+")).join(" ");
		if (keys) {
			row.add(
				new TextRenderable(this.renderer, {
					content: keys,
					fg: selected ? this.theme.accent : this.theme.muted,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
					flexShrink: 0,
				}),
			);
		}
		return row;
	}
}

const GROUP_ORDER = ["Commands", "Model", "Agent", "Session", "View", "App", "Other"];

function orderForPalette(commands: readonly IoCommand[]): IoCommand[] {
	const suggested = commands.filter((command) => command.suggested);
	const rest = commands
		.filter((command) => !command.suggested)
		.sort((left, right) => {
			const leftGroup = GROUP_ORDER.indexOf(left.group ?? "Other");
			const rightGroup = GROUP_ORDER.indexOf(right.group ?? "Other");
			return leftGroup - rightGroup || left.title.localeCompare(right.title);
		});
	return [...suggested, ...rest];
}

function matchScore(command: IoCommand, query: string): number | undefined {
	if (!query) return 0;
	const haystack = `${command.id} ${command.title} ${command.description ?? ""} ${command.group ?? ""} ${(command.keys ?? []).join(" ")}`.toLowerCase();
	const direct = haystack.indexOf(query);
	if (direct !== -1) return direct;
	let cursor = 0;
	for (const char of query) {
		cursor = haystack.indexOf(char, cursor);
		if (cursor === -1) return undefined;
		cursor += 1;
	}
	return 100 + cursor;
}

function clearChildren(container: { getChildren(): readonly { destroyRecursively(): void }[]; remove(child: never): void }): void {
	for (const child of [...container.getChildren()]) {
		container.remove(child as never);
		child.destroyRecursively();
	}
}
