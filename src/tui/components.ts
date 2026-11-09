import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	Box,
	Container,
	Input,
	Markdown,
	Spacer,
	Text,
	TruncatedText,
	fuzzyFilter,
	getKeybindings,
	getSelectPageIndex,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	Key,
	type Component,
} from "@earendil-works/pi-tui";
import { formatDuration, formatTokens } from "../format.js";
import { markdownTheme, style } from "./theme.js";

const ASSISTANT_UPDATE_INTERVAL_MS = 50;
const TOOL_PREVIEW_LINES = 24;

function sanitizeOutput(value: string): string {
	return stripTerminalSequences(value)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block && typeof block === "object") {
				const typed = block as { type?: unknown; text?: unknown };
				if (typed.type === "text" && typeof typed.text === "string") return typed.text;
				if (typed.type === "image") return "[image]";
			}
			return "";
		})
		.filter((part) => part.length > 0)
		.join("\n");
}

/**
 * Text with a prefix on the first line. Continuation lines keep the same
 * indentation, and wrapping is delegated to pi-tui so wide characters and
 * ANSI styles behave correctly.
 */
export class PrefixedText implements Component {
	private text = "";
	private readonly prefix: string;
	private readonly continuation: string;

	constructor(text: string, prefix: string, continuation = " ".repeat(visibleWidth(prefix))) {
		this.text = text;
		this.prefix = prefix;
		this.continuation = continuation;
	}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const logicalLines = this.text.split("\n");
		for (let index = 0; index < logicalLines.length; index++) {
			const prefix = index === 0 ? this.prefix : this.continuation;
			const available = Math.max(1, width - visibleWidth(prefix));
			const line = logicalLines[index] ?? "";
			const wrapped = wrapTextWithAnsi(line, available);
			if (wrapped.length === 0) {
				lines.push(prefix.trimEnd());
				continue;
			}
			for (const part of wrapped) {
				lines.push(prefix + part);
			}
		}
		return lines;
	}
}

export class UserBlock extends PrefixedText {
	constructor(text: string) {
		super(sanitizeOutput(text), style.bold("› "), "  ");
	}
}

/**
 * Horizontal rule that fills the viewport width, in the style of Pi's
 * DynamicBorder. Used as the top/bottom shell of pickers so overlays read as
 * bordered panels instead of loose text in padded space.
 */
export class DynamicBorder implements Component {
	private readonly colorFn: (text: string) => string;

	constructor(colorFn: (text: string) => string = style.dim) {
		this.colorFn = colorFn;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [this.colorFn("─".repeat(Math.max(1, width)))];
	}
}

/**
 * Search text for the model picker, in Pi's ModelSelector style
 * (`provider provider/id id name`). The provider comes first so that an exact
 * provider-prefixed query ranks ahead of proxy IDs that merely contain the
 * characters. Matched with `fuzzyFilter`, so typing `kimi` finds
 * `opencode-go/kimi-k3` without having to type the full reference.
 */
export function modelSearchText(item: { id: string; provider: string; name?: string }): string {
	const name = item.name ? ` ${item.name}` : "";
	return `${item.provider} ${item.provider}/${item.id} ${item.id}${name}`;
}

const splitModelLabel = (value: string): string[] =>
	value
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);

/**
 * Return the model name only when it adds words the id does not already
 * contain (Pi's getDistinctModelName). `Kimi K3` for `kimi-k3` has no new
 * words and renders as nothing; a renamed override keeps its full name.
 */
export function distinctModelName(item: { id: string; name?: string }): string | undefined {
	const name = item.name?.trim();
	if (!name) return undefined;
	const idWords = splitModelLabel(item.id);
	const idTokens = new Set(idWords);
	const compactId = idWords.join("");
	const isCovered = (word: string): boolean =>
		idTokens.has(word) || (word.length > 1 && compactId.includes(word));
	return splitModelLabel(name).every(isCovered) ? undefined : name;
}

export interface ModelPickerItem {
	id: string;
	provider: string;
	name?: string;
	contextWindow?: number;
}

export interface ModelPickerOptions {
	maxVisible?: number;
	/** `provider/id` of the model in use; it gets the `✓` marker. */
	currentValue?: string;
	onSelect: (item: ModelPickerItem) => void;
	onCancel: () => void;
}

const MODEL_PICKER_MAX_VISIBLE = 10;

/**
 * Model selector in Pi's shape: a bordered panel with a real `Input` for the
 * filter and a fuzzy-filtered list (`→` cursor, `✓` current marker,
 * `[provider]` badge, `(i/n)` scroll, selected `Model Name` footer).
 *
 * This exists because Pi's `SelectList.setFilter` matches with `startsWith` on
 * `value`, which can never find `opencode-go/kimi-k3` from `kimi`. The picker
 * owns filtering through `fuzzyFilter` instead, like Pi's own
 * ModelSelectorComponent, and never touches `SelectList` internals.
 */
export class ModelPicker extends Container {
	readonly capturesViewportInput = true;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private readonly allItems: ModelPickerItem[];
	private filteredItems: ModelPickerItem[];
	private selectedIndex = 0;
	private readonly maxVisible: number;
	private readonly currentValue: string | undefined;
	private readonly onSelectCallback: (item: ModelPickerItem) => void;
	private readonly onCancelCallback: () => void;
	readonly searchInput: Input;
	private readonly listContainer: Container;

	constructor(items: ModelPickerItem[], options: ModelPickerOptions) {
		super();
		this.allItems = items;
		this.filteredItems = items;
		this.maxVisible = Math.max(1, options.maxVisible ?? MODEL_PICKER_MAX_VISIBLE);
		this.currentValue = options.currentValue;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(style.bold("Select a model"), 0, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input({
			prompt: "> ",
			placeholder: "Filter models…",
			placeholderStyle: style.dim,
		});
		this.searchInput.onSubmit = () => {
			const selected = this.filteredItems[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		};
		this.searchInput.onEscape = () => this.onCancelCallback();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(style.dim("↑↓ move · enter select · esc cancel"), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		if (this.currentValue) {
			const index = this.filteredItems.findIndex(
				(item) => `${item.provider}/${item.id}` === this.currentValue,
			);
			if (index >= 0) this.selectedIndex = index;
		}
		this.updateList();
	}

	getSelectedItem(): ModelPickerItem | undefined {
		return this.filteredItems[this.selectedIndex];
	}

	private filterModels(query: string): void {
		this.filteredItems = query.trim().length > 0
			? fuzzyFilter(this.allItems, query, (item) => modelSearchText(item))
			: this.allItems;
		this.selectedIndex = query
			? 0
			: Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new TruncatedText(style.dim("  No matching models"), 1, 0));
			return;
		}
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				this.filteredItems.length - this.maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
		for (let index = startIndex; index < endIndex; index++) {
			const item = this.filteredItems[index];
			if (!item) continue;
			const isSelected = index === this.selectedIndex;
			const isCurrent =
				this.currentValue !== undefined &&
				`${item.provider}/${item.id}` === this.currentValue;
			const cursor = isSelected ? style.bold("→ ") : "  ";
			const currentMarker = isCurrent ? style.bold("✓ ") : "  ";
			const idText = isSelected ? style.bold(item.id) : item.id;
			const name = distinctModelName(item);
			const nameText = name ? style.dim(` (${name})`) : "";
			const providerBadge = style.dim(` [${item.provider}]`);
			this.listContainer.addChild(
				new TruncatedText(`${cursor}${currentMarker}${idText}${nameText} ${providerBadge}`, 1, 0),
			);
		}
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			this.listContainer.addChild(
				new TruncatedText(
					style.dim(`  (${this.selectedIndex + 1}/${this.filteredItems.length})`),
					1,
					0,
				),
			);
		}
		const selected = this.filteredItems[this.selectedIndex];
		if (selected) {
			this.listContainer.addChild(new Spacer(1));
			const context = selected.contextWindow
				? ` · ${formatTokens(selected.contextWindow)} ctx`
				: "";
			this.listContainer.addChild(
				new TruncatedText(
					style.dim(`  Model Name: ${selected.name ?? selected.id}${context}`),
					1,
					0,
				),
			);
		}
	}

	handleInput(keyData: string): void {
		const keybindings = getKeybindings();
		const pageIndex = getSelectPageIndex(
			keybindings,
			keyData,
			this.selectedIndex,
			this.filteredItems.length,
			this.maxVisible,
		);
		if (keybindings.matches(keyData, "tui.select.up")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex =
				this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.updateList();
		} else if (keybindings.matches(keyData, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex =
				this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		} else if (pageIndex !== undefined) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = pageIndex;
			this.updateList();
		} else if (keybindings.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredItems[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (keybindings.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		} else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}
}

/**
 * Horizontal/vertical padding for overlay content. A full-width overlay clears
 * the base transcript behind it, avoiding stray text in the margins.
 *
 * Implemented with pi-tui's `Box` (same padding contract, plus a cache and
 * mouse dispatch) instead of a hand-rolled padder.
 */
export class PaddedBox implements Component {
	private readonly box: Box;

	constructor(child: Component, paddingX = 2, paddingY = 1) {
		this.box = new Box(paddingX, paddingY);
		this.box.addChild(child);
	}

	invalidate(): void {
		this.box.invalidate();
	}

	render(width: number): string[] {
		return this.box.render(width);
	}
}

export class AssistantBlock implements Component {
	private readonly markdown: Markdown;
	private text = "";
	private note: string | undefined;
	private noteView: Text | undefined;
	private timer: NodeJS.Timeout | undefined;
	private pendingMessage: AssistantMessage | undefined;
	private readonly requestRender: () => void;

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
		this.markdown = new Markdown("", 0, 0, markdownTheme);
	}

	setMessage(message: AssistantMessage, streaming: boolean): void {
		this.pendingMessage = message;
		if (this.timer) clearTimeout(this.timer);
		if (streaming) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.flush();
			}, ASSISTANT_UPDATE_INTERVAL_MS);
			this.timer.unref?.();
			return;
		}
		this.flush();
	}

	private flush(): void {
		const message = this.pendingMessage;
		if (!message) return;
		const text = sanitizeOutput(
			message.content
				.filter((block) => block.type === "text")
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("\n\n"),
		);
		if (text !== this.text) {
			this.text = text;
			this.markdown.setText(text);
		}

		let note: string | undefined;
		if (message.stopReason === "error") {
			note = style.bold("error: ") + sanitizeOutput(message.errorMessage || "unknown provider error");
		} else if (message.stopReason === "aborted") {
			const detail =
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? `: ${sanitizeOutput(message.errorMessage)}`
					: "";
			note = style.dim(`cancelled${detail}`);
		} else if (message.stopReason === "length") {
			note = style.dim("response truncated before completion");
		}
		if (note !== this.note) {
			this.note = note;
			this.noteView = note === undefined ? undefined : new Text(note, 0, 0);
		}
		this.requestRender();
	}

	getText(): string {
		return this.text;
	}

	invalidate(): void {
		this.markdown.invalidate();
		this.noteView?.invalidate();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		if (this.text.trim().length > 0) {
			lines.push(...this.markdown.render(width));
		}
		if (this.noteView) {
			if (lines.length > 0) lines.push("");
			lines.push(...this.noteView.render(width));
		}
		return lines;
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}

export interface ToolResultLike {
	content?: unknown;
	details?: unknown;
}

export class ToolBlock extends Container {
	private readonly command: string;
	private readonly toolName: string;
	private readonly header: PrefixedText;
	private readonly outputView: Text;
	private readonly statusView: Text;
	private readonly requestRender: () => void;
	private rawOutput = "";
	private expanded = false;
	private running = true;
	private isError = false;
	private durationMs: number | undefined;
	private fullOutputPath: string | undefined;

	constructor(toolName: string, command: string, requestRender: () => void) {
		super();
		this.toolName = toolName;
		this.command = sanitizeOutput(command);
		this.requestRender = requestRender;
		const prefix = toolName === "bash" ? style.bold("$ ") : `${toolName} `;
		this.header = new PrefixedText(this.command, prefix, "  ");
		this.outputView = new Text("", 2, 0);
		this.statusView = new Text("", 2, 0);
		this.addChild(this.header);
		this.addChild(this.outputView);
		this.addChild(this.statusView);
		this.refresh();
	}

	setResult(result: ToolResultLike | undefined, isError: boolean, durationMs?: number): void {
		this.running = false;
		this.isError = isError;
		this.durationMs = durationMs;
		if (result) {
			this.rawOutput = sanitizeOutput(contentText(result.content));
			const details = result.details as { fullOutputPath?: unknown } | undefined;
			if (details && typeof details.fullOutputPath === "string") {
				this.fullOutputPath = details.fullOutputPath;
			}
		}
		this.refresh();
	}

	setPartial(result: ToolResultLike | undefined): void {
		if (!result) return;
		this.rawOutput = sanitizeOutput(contentText(result.content));
		this.refresh();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.refresh();
	}

	getExpanded(): boolean {
		return this.expanded;
	}

	getCommand(): string {
		return this.command;
	}

	private refresh(): void {
		const lines = this.rawOutput.replace(/\n+$/, "").split("\n");
		if (this.rawOutput.length === 0) lines.length = 0;

		let visible = lines;
		let hiddenNote: string | undefined;
		if (!this.expanded && lines.length > TOOL_PREVIEW_LINES) {
			if (this.running) {
				const shown = lines.slice(-TOOL_PREVIEW_LINES);
				hiddenNote = `… ${lines.length - shown.length} earlier lines hidden (ctrl+o to expand)`;
				visible = shown;
			} else {
				const half = Math.floor(TOOL_PREVIEW_LINES / 2);
				const head = lines.slice(0, half);
				const tail = lines.slice(-half);
				hiddenNote = `… ${lines.length - head.length - tail.length} lines hidden (ctrl+o to expand)`;
				visible = [...head, "", hiddenNote, "", ...tail];
				hiddenNote = undefined;
			}
		}
		const output = visible.map((line) => style.dim(line)).join("\n");
		this.outputView.setText(output.length > 0 ? output : "");

		const status: string[] = [];
		if (this.running) {
			status.push(style.dim("running…"));
		} else if (this.isError) {
			status.push(style.bold("error"));
			if (this.durationMs !== undefined) status.push(style.dim(formatDuration(this.durationMs)));
		} else {
			status.push(style.dim(this.durationMs !== undefined ? `done · ${formatDuration(this.durationMs)}` : "done"));
		}
		if (this.fullOutputPath) {
			status.push(style.dim(`full output: ${this.fullOutputPath}`));
		}
		if (hiddenNote) status.push(style.dim(hiddenNote));
		this.statusView.setText(status.join(style.dim(" · ")));

		this.header.setText(this.command);
		this.requestRender();
	}
}

export class NoticeBlock extends Text {
	constructor(text: string, options: { dim?: boolean; bold?: boolean } = {}) {
		const styled = options.bold ? style.bold(text) : options.dim ? style.dim(text) : text;
		super(styled, 0, 0);
	}
}

export interface FooterState {
	modelRef?: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	speed?: string;
	context?: string;
	sessionId?: string;
	busy?: boolean;
	status?: string;
	/** Current braille frame while busy (Pi Loader frame set). */
	spinner?: string;
	queued?: number;
}

export class Footer implements Component {
	private state: FooterState = {};

	setState(state: FooterState): void {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const header: string[] = [];
		if (this.state.modelRef) header.push(style.bold(this.state.modelRef));
		let status = this.state.busy ? (this.state.status ?? "generating") : "ready";
		if ((this.state.queued ?? 0) > 0) status += ` · queued ${this.state.queued}`;
		if (this.state.busy && this.state.spinner) status = `${this.state.spinner} ${status}`;
		header.push(this.state.busy ? style.bold(status) : style.dim(status));
		if (this.state.sessionId) header.push(style.dim(`session ${this.state.sessionId.slice(0, 8)}`));

		const metrics: string[] = [];
		if (this.state.usage) {
			const usage: string[] = [];
			if (this.state.usage.input > 0) usage.push(`in ${formatTokens(this.state.usage.input)}`);
			if (this.state.usage.output > 0) usage.push(`out ${formatTokens(this.state.usage.output)}`);
			if (usage.length > 0) metrics.push(style.dim(usage.join(" ")));
		}
		if (this.state.speed) metrics.push(style.dim(this.state.speed));
		if (this.state.context) metrics.push(style.dim(this.state.context));

		const separator = style.dim(" · ");
		const headerLine = header.join(separator);
		const metricsLine = metrics.join(separator);
		if (metrics.length === 0) return [truncateToWidth(headerLine, width, "…")];
		const combined = `${headerLine}${separator}${metricsLine}`;
		if (visibleWidth(combined) <= width) return [combined];
		return [
			truncateToWidth(headerLine, width, "…"),
			truncateToWidth(metricsLine, width, "…"),
		];
	}
}

export class ConfirmOverlay implements Component {
	private readonly command: string;
	private readonly reason: string;
	private readonly done: (allowed: boolean) => void;
	private readonly cancelGeneration: (() => void) | undefined;
	private finished = false;

	constructor(
		command: string,
		reason: string,
		done: (allowed: boolean) => void,
		cancelGeneration?: () => void,
	) {
		this.command = sanitizeOutput(command);
		this.reason = sanitizeOutput(reason);
		this.done = done;
		this.cancelGeneration = cancelGeneration;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.finished) return;
		if (data === "y" || data === "Y") {
			this.finished = true;
			this.done(true);
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this.finished = true;
			this.cancelGeneration?.();
			this.done(false);
			return;
		}
		if (data === "n" || data === "N" || matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
			this.finished = true;
			this.done(false);
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(new DynamicBorder().render(width)[0] ?? "");
		lines.push(style.bold("Run this command?"));
		lines.push("");
		for (const line of this.command.replace(/\r/g, "").split("\n")) {
			const wrapped = wrapTextWithAnsi(`$ ${line}`, width);
			for (const part of wrapped) lines.push(part);
		}
		lines.push("");
		lines.push(truncateToWidth(style.dim(`Reason: ${this.reason}`), width, "…"));
		lines.push("");
		lines.push(truncateToWidth(style.dim("[y] allow    [n] deny"), width, "…"));
		lines.push(new DynamicBorder().render(width)[0] ?? "");
		return lines;
	}
}
