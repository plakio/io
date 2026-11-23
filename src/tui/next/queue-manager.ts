import {
	BoxRenderable,
	InputRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoQueueManagerOptions {
	renderer: CliRenderer;
	shell: IoShell;
	queue: readonly string[];
	theme?: IoTheme;
	onChange?: (queue: readonly string[]) => void;
	onSteer?: (prompt: string) => void | Promise<void>;
	onClose?: () => void;
	onError?: (error: unknown) => void;
}

/** Manage queued prompts: edit, delete, reorder or steer one now. */
export class IoQueueManager {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly theme: IoTheme;
	private readonly callbacks: Pick<IoQueueManagerOptions, "onChange" | "onSteer" | "onClose" | "onError">;
	private queue: string[];
	private panel: BoxRenderable | undefined;
	private list: ScrollBoxRenderable | undefined;
	private editBox: BoxRenderable | undefined;
	private editInput: InputRenderable | undefined;
	private selected = 0;
	private opened = false;
	private editing = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoQueueManagerOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.theme = options.theme ?? ioDarkTheme;
		this.queue = [...options.queue];
		this.callbacks = options;
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get queued(): readonly string[] {
		return this.queue;
	}

	get selectedPrompt(): string | undefined {
		return this.queue[this.selected];
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
		this.editing = false;
		this.renderer.keyInput.off("keypress", this.keyHandler);
		this.panel = undefined;
		this.list = undefined;
		this.editBox = undefined;
		this.editInput = undefined;
		this.shell.hideOverlay();
		this.callbacks.onClose?.();
		this.renderer.requestRender();
	}

	setQueue(queue: readonly string[]): void {
		this.queue = [...queue];
		this.selected = Math.min(this.selected, Math.max(0, this.queue.length - 1));
		this.refresh();
	}

	move(delta: number): void {
		if (this.queue.length === 0) return;
		this.selected = (this.selected + delta + this.queue.length) % this.queue.length;
		this.refresh();
	}

	moveSelected(delta: number): boolean {
		const target = this.selected + delta;
		if (target < 0 || target >= this.queue.length) return false;
		const next = [...this.queue];
		const [item] = next.splice(this.selected, 1);
		if (item === undefined) return false;
		next.splice(target, 0, item);
		this.queue = next;
		this.selected = target;
		this.emitChange();
		this.refresh();
		return true;
	}

	startEdit(): boolean {
		if (!this.editBox || !this.editInput || !this.list) return false;
		const prompt = this.selectedPrompt;
		if (prompt === undefined) return false;
		this.editing = true;
		this.list.visible = false;
		this.editBox.visible = true;
		this.editInput.value = prompt;
		this.editInput.focus();
		this.renderer.requestRender();
		return true;
	}

	commitEdit(text?: string): boolean {
		const value = (text ?? this.editInput?.value ?? "").trim();
		if (!value || this.selectedPrompt === undefined) return false;
		this.queue = this.queue.map((prompt, index) => (index === this.selected ? value : prompt));
		this.cancelEdit();
		this.emitChange();
		this.refresh();
		return true;
	}

	cancelEdit(): void {
		this.editing = false;
		if (this.editBox) this.editBox.visible = false;
		if (this.list) this.list.visible = true;
		this.renderer.requestRender();
	}

	deleteSelected(): boolean {
		if (this.selectedPrompt === undefined) return false;
		this.queue = this.queue.filter((_, index) => index !== this.selected);
		this.selected = Math.min(this.selected, Math.max(0, this.queue.length - 1));
		this.emitChange();
		this.refresh();
		return true;
	}

	async steerSelected(): Promise<boolean> {
		const prompt = this.selectedPrompt;
		if (prompt === undefined) return false;
		this.queue = this.queue.filter((_, index) => index !== this.selected);
		this.selected = Math.min(this.selected, Math.max(0, this.queue.length - 1));
		this.emitChange();
		try {
			await this.callbacks.onSteer?.(prompt);
		} catch (error) {
			this.callbacks.onError?.(error);
		}
		this.refresh();
		return true;
	}

	dispose(): void {
		this.close();
	}

	private handleKey(event: IoKeyEvent): void {
		if (!this.opened || event.defaultPrevented) return;
		const name = event.name.toLowerCase();
		if (this.editing) {
			if (name === "escape") this.cancelEdit();
			else if (name === "return") this.commitEdit();
			else return;
			event.preventDefault?.();
			event.stopPropagation?.();
			return;
		}
		if (name === "escape") this.close();
		else if (name === "up" || name === "k") this.move(-1);
		else if (name === "down" || name === "j") this.move(1);
		else if (name === "e" || (event.ctrl && name === "e")) this.startEdit();
		else if (name === "d" || (event.ctrl && name === "d")) this.deleteSelected();
		else if (name === "]" || (event.ctrl && name === "j")) this.moveSelected(1);
		else if (name === "[" || (event.ctrl && name === "k")) this.moveSelected(-1);
		else if (name === "s" || (event.ctrl && name === "s")) void this.steerSelected();
		else return;
		event.preventDefault?.();
		event.stopPropagation?.();
	}

	private buildPanel(): BoxRenderable {
		const panel = new BoxRenderable(this.renderer, {
			width: "78%",
			maxWidth: 90,
			height: "58%",
			maxHeight: 22,
			border: true,
			borderColor: this.theme.border,
			title: "Queued prompts",
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
		const editBox = new BoxRenderable(this.renderer, {
			flexGrow: 1,
			flexShrink: 1,
			flexDirection: "column",
			visible: false,
			backgroundColor: this.theme.panel,
		});
		const editInput = new InputRenderable(this.renderer, {
			value: "",
			placeholder: "Edit queued prompt…",
			textColor: this.theme.text,
			backgroundColor: this.theme.panel,
			focusedBackgroundColor: this.theme.panel,
			focusedTextColor: this.theme.text,
			placeholderColor: this.theme.muted,
		});
		editBox.add(editInput);
		editBox.add(
			new TextRenderable(this.renderer, {
				content: "enter save · esc cancel",
				fg: this.theme.muted,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
			}),
		);
		panel.add(list);
		panel.add(editBox);
		panel.add(
			new TextRenderable(this.renderer, {
				content: "↑↓ move · e edit · d delete · [/] reorder · s steer · esc close",
				fg: this.theme.muted,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
				truncate: true,
			}),
		);
		this.list = list;
		this.editBox = editBox;
		this.editInput = editInput;
		return panel;
	}

	private refresh(): void {
		if (!this.list) return;
		if (this.panel) this.panel.title = `Queued prompts (${this.queue.length})`;
		clearChildren(this.list);
		if (this.queue.length === 0) {
			this.list.add(
				new TextRenderable(this.renderer, {
					content: "Queue is empty",
					fg: this.theme.muted,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
				}),
			);
		} else {
			this.queue.forEach((prompt, index) => {
				const selected = index === this.selected;
				this.list?.add(
					new TextRenderable(this.renderer, {
						content: `${selected ? "›" : " "} ${index + 1}. ${prompt}`,
						fg: selected ? this.theme.accent : this.theme.text,
						bg: this.theme.panel,
						height: 1,
						wrapMode: "none",
						truncate: true,
					}),
				);
			});
		}
		this.renderer.requestRender();
	}

	private emitChange(): void {
		this.callbacks.onChange?.([...this.queue]);
		this.renderer.requestRender();
	}
}

function clearChildren(container: { getChildren(): readonly { destroyRecursively(): void }[]; remove(child: never): void }): void {
	for (const child of [...container.getChildren()]) {
		container.remove(child as never);
		child.destroyRecursively();
	}
}
