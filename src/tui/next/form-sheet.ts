import {
	BoxRenderable,
	InputRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { EngineForm, EngineFormField, EngineFormValue } from "../../engine/types.js";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoFormSheetOptions {
	renderer: CliRenderer;
	shell: IoShell;
	form: EngineForm;
	theme?: IoTheme;
	onReply: (form: EngineForm, answer: Record<string, EngineFormValue>) => void | Promise<void>;
	onCancel: (form: EngineForm, message: string) => void | Promise<void>;
	onClose?: () => void;
	onError?: (error: unknown) => void;
}

/** Agent question form: text, number, boolean, single and multi select fields. */
export class IoFormSheet {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly form: EngineForm;
	private readonly fields: readonly EngineFormField[];
	private readonly theme: IoTheme;
	private readonly onReply: IoFormSheetOptions["onReply"];
	private readonly onCancel: IoFormSheetOptions["onCancel"];
	private readonly onClose: (() => void) | undefined;
	private readonly onError: ((error: unknown) => void) | undefined;
	private readonly values: Record<string, EngineFormValue> = {};
	private panel: BoxRenderable | undefined;
	private list: ScrollBoxRenderable | undefined;
	private input: InputRenderable | undefined;
	private status: TextRenderable | undefined;
	private index = 0;
	private optionIndex = 0;
	private opened = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoFormSheetOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.form = options.form;
		this.fields = options.form.fields.filter((field) => !field.hidden);
		this.theme = options.theme ?? ioDarkTheme;
		this.onReply = options.onReply;
		this.onCancel = options.onCancel;
		this.onClose = options.onClose;
		this.onError = options.onError;
		for (const field of this.fields) {
			if (field.default !== undefined) this.values[field.key] = field.default;
			else if (field.type === "boolean") this.values[field.key] = false;
			else if (field.type === "multiselect") this.values[field.key] = [];
			else this.values[field.key] = "";
		}
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get currentField(): EngineFormField | undefined {
		return this.fields[this.index];
	}

	get answers(): Record<string, EngineFormValue> {
		return { ...this.values };
	}

	open(): void {
		if (this.opened) return;
		this.opened = true;
		this.panel = this.buildPanel();
		this.shell.showOverlay(this.panel);
		this.renderer.keyInput.prependListener("keypress", this.keyHandler);
		this.index = 0;
		this.optionIndex = this.optionIndexFor(this.currentField);
		this.render();
		this.renderer.requestRender();
	}

	close(): void {
		if (!this.opened) return;
		this.opened = false;
		this.renderer.keyInput.off("keypress", this.keyHandler);
		this.input = undefined;
		this.list = undefined;
		this.status = undefined;
		this.panel = undefined;
		this.shell.hideOverlay();
		this.onClose?.();
		this.renderer.requestRender();
	}

	setText(text: string): void {
		if (this.input) this.input.value = text;
	}

	advance(): boolean {
		const field = this.currentField;
		if (!field) return false;
		if (!this.commit(field, true)) return false;
		if (this.index >= this.fields.length - 1) {
			this.submit();
			return true;
		}
		this.index += 1;
		this.optionIndex = this.optionIndexFor(this.currentField);
		this.render();
		return true;
	}

	moveField(delta: number): void {
		if (this.fields.length === 0) return;
		this.index = (this.index + delta + this.fields.length) % this.fields.length;
		this.optionIndex = this.optionIndexFor(this.currentField);
		this.render();
	}

	toggle(): void {
		const field = this.currentField;
		if (!field) return;
		if (field.type === "boolean") {
			this.values[field.key] = this.values[field.key] !== true;
		} else if (field.type === "multiselect") {
			const options = field.options ?? [];
			const option = options[this.optionIndex];
			if (!option) return;
			const current = Array.isArray(this.values[field.key]) ? [...(this.values[field.key] as string[])] : [];
			const index = current.indexOf(option.value);
			if (index >= 0) current.splice(index, 1);
			else current.push(option.value);
			this.values[field.key] = current;
		}
		this.render();
	}

	moveOption(delta: number): void {
		const field = this.currentField;
		if (!field?.options || field.options.length === 0) return;
		this.optionIndex = (this.optionIndex + delta + field.options.length) % field.options.length;
		const option = field.options[this.optionIndex];
		if (option && field.type === "string") this.values[field.key] = option.value;
		this.render();
	}

	submit(): boolean {
		for (const field of this.fields) {
			if (field.required && !hasValue(this.values[field.key])) {
				this.index = this.fields.indexOf(field);
				this.setStatus(`${field.title ?? field.key} is required`);
				this.render();
				return false;
			}
		}
		void Promise.resolve(this.onReply(this.form, this.answers)).catch((error) => this.onError?.(error));
		this.close();
		return true;
	}

	cancel(): void {
		void Promise.resolve(this.onCancel(this.form, "Cancelled by user")).catch((error) => this.onError?.(error));
		this.close();
	}

	dispose(): void {
		this.close();
	}

	private commit(field: EngineFormField, fromInput: boolean): boolean {
		if (field.type === "string" && !field.options) {
			const value = fromInput ? (this.input?.value.trim() ?? "") : String(this.values[field.key] ?? "");
			this.values[field.key] = value;
			if (field.required && !value) {
				this.setStatus(`${field.title ?? field.key} is required`);
				return false;
			}
		} else if (field.type === "number" || field.type === "integer") {
			const raw = fromInput ? (this.input?.value.trim() ?? "") : String(this.values[field.key] ?? "");
			const value = Number(raw);
			if (raw.length === 0) {
				this.values[field.key] = "";
				if (field.required) {
					this.setStatus(`${field.title ?? field.key} is required`);
					return false;
				}
				return true;
			}
			if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) {
				this.setStatus(`invalid ${field.type}: ${raw}`);
				return false;
			}
			this.values[field.key] = value;
		} else if (field.type === "boolean") {
			if (typeof this.values[field.key] !== "boolean") this.values[field.key] = false;
		} else if (field.type === "multiselect") {
			if (!Array.isArray(this.values[field.key])) this.values[field.key] = [];
		} else if (field.options && field.options.length > 0 && fromInput) {
			const option = field.options[this.optionIndex];
			if (option && !hasValue(this.values[field.key])) this.values[field.key] = option.value;
		}
		if (field.required && !hasValue(this.values[field.key])) {
			this.setStatus(`${field.title ?? field.key} is required`);
			return false;
		}
		return true;
	}

	private handleKey(event: IoKeyEvent): void {
		if (!this.opened || event.defaultPrevented) return;
		const name = event.name.toLowerCase();
		const field = this.currentField;
		const editing = this.input?.visible === true;
		if (name === "escape") this.cancel();
		else if (name === "tab") this.advance();
		else if (name === "up") {
			if (field?.options && field.type !== "multiselect") this.moveOption(-1);
			else this.moveField(-1);
		} else if (name === "down") {
			if (field?.options && field.type !== "multiselect") this.moveOption(1);
			else this.moveField(1);
		} else if (name === "return") {
			if (editing) return;
			if (field?.type === "multiselect") this.advance();
			else if (field?.type === "boolean") this.toggle();
			else this.advance();
		} else if (name === "space") {
			if (!editing && (field?.type === "boolean" || field?.type === "multiselect")) this.toggle();
			else return;
		} else return;
		event.preventDefault?.();
		event.stopPropagation?.();
	}

	private buildPanel(): BoxRenderable {
		const panel = new BoxRenderable(this.renderer, {
			width: "72%",
			maxWidth: 92,
			height: "70%",
			maxHeight: 26,
			border: true,
			borderColor: this.theme.border,
			title: this.form.title,
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
			content: "",
			fg: this.theme.muted,
			bg: this.theme.panel,
			wrapMode: "word",
		});
		const input = new InputRenderable(this.renderer, {
			value: "",
			placeholder: "Value",
			textColor: this.theme.text,
			backgroundColor: this.theme.panel,
			focusedBackgroundColor: this.theme.panel,
			focusedTextColor: this.theme.text,
			placeholderColor: this.theme.muted,
		});
		input.onSubmit = () => this.advance();
		const hint = new TextRenderable(this.renderer, {
			content: "tab next · ↑↓ fields/options · space toggle · enter advance · esc cancel",
			fg: this.theme.muted,
			bg: this.theme.panel,
			height: 1,
			wrapMode: "none",
			truncate: true,
		});
		panel.add(list);
		panel.add(status);
		panel.add(input);
		panel.add(hint);
		this.list = list;
		this.status = status;
		this.input = input;
		return panel;
	}

	private render(): void {
		if (!this.list || !this.input) return;
		clearChildren(this.list);
		const field = this.currentField;
		for (const [index, item] of this.fields.entries()) {
			const active = index === this.index;
			const value = formatValue(item, this.values[item.key]);
			const fieldRow = new TextRenderable(this.renderer, {
				content: `${active ? "›" : " "} ${item.title ?? item.key}${item.required ? " *" : ""}: ${value}`,
				fg: active ? this.theme.accent : this.theme.text,
				bg: this.theme.panel,
				wrapMode: "word",
			});
			fieldRow.onMouseDown = () => {
				this.index = index;
				this.optionIndex = this.optionIndexFor(item);
				this.render();
			};
			this.list.add(fieldRow);
			if (active && item.description) {
				this.list.add(
					new TextRenderable(this.renderer, {
						content: `   ${item.description}`,
						fg: this.theme.muted,
						bg: this.theme.panel,
						wrapMode: "word",
					}),
				);
			}
			if (active && item.options && item.options.length > 0) {
				for (const [optionIndex, option] of item.options.entries()) {
					const selected =
						item.type === "multiselect"
							? Array.isArray(this.values[item.key]) && (this.values[item.key] as string[]).includes(option.value)
							: optionIndex === this.optionIndex;
					const optionRow = new TextRenderable(this.renderer, {
						content: `   ${selected ? "●" : "○"} ${option.label}`,
						fg: optionIndex === this.optionIndex ? this.theme.accent : selected ? this.theme.success : this.theme.muted,
						bg: this.theme.panel,
						wrapMode: "none",
						truncate: true,
					});
					optionRow.onMouseDown = () => {
						this.optionIndex = optionIndex;
						if (item.type === "multiselect") this.toggle();
						else {
							this.values[item.key] = option.value;
							this.render();
						}
					};
					this.list.add(optionRow);
				}
			}
			if (active && item.type === "external" && item.url) {
				this.list.add(
					new TextRenderable(this.renderer, {
						content: `   ${item.url}`,
						fg: this.theme.muted,
						bg: this.theme.panel,
						wrapMode: "word",
					}),
				);
			}
		}
		const editable = field ? (field.type === "string" && !field.options) || field.type === "number" || field.type === "integer" : false;
		this.input.visible = editable;
		if (editable && field) {
			this.input.value = String(this.values[field.key] ?? "");
			this.input.placeholder = field.title ?? field.key;
			this.input.focus();
		} else {
			this.input.blur();
		}
		this.setStatus(`${this.index + 1}/${this.fields.length} · ${this.hintFor(field)}`);
		this.renderer.requestRender();
	}

	private hintFor(field: EngineFormField | undefined): string {
		if (!field) return "";
		if (field.type === "boolean") return "enter or space toggles";
		if (field.type === "multiselect") return "↑↓ option · space toggle · enter next";
		if (field.options?.length) return "↑↓ option · enter next";
		if (field.type === "external") return "enter next";
		return "type a value · enter next";
	}

	private setStatus(message: string): void {
		if (this.status) this.status.content = message;
	}

	private optionIndexFor(field: EngineFormField | undefined): number {
		if (!field?.options || field.options.length === 0) return 0;
		const value = this.values[field.key];
		const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
		const index = field.options.findIndex((option) => values.includes(option.value));
		return index >= 0 ? index : 0;
	}
}

function formatValue(field: EngineFormField, value: EngineFormValue | undefined): string {
	if (value === undefined || value === "") return "—";
	if (Array.isArray(value)) {
		const labels = value.map((item) => field.options?.find((option) => option.value === item)?.label ?? item);
		return labels.length > 0 ? labels.join(", ") : "—";
	}
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (field.options) return field.options.find((option) => option.value === String(value))?.label ?? String(value);
	return String(value);
}

function hasValue(value: EngineFormValue | undefined): boolean {
	if (Array.isArray(value)) return value.length > 0;
	return value !== undefined && value !== "";
}

function clearChildren(container: { getChildren(): readonly { destroyRecursively(): void }[]; remove(child: never): void }): void {
	for (const child of [...container.getChildren()]) {
		container.remove(child as never);
		child.destroyRecursively();
	}
}
