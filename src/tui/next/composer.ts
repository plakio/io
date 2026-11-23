import type { CliRenderer, TextareaRenderable } from "@opentui/core";

export type IoComposerMode = "prompt" | "shell" | "command";
export type IoPromptDelivery = "steer" | "queue";

export interface IoCompletionItem {
	/** Text inserted when the completion is accepted. */
	value: string;
	description?: string;
	kind?: "command" | "path" | "model" | "session";
}

export interface IoComposerOptions {
	renderer: CliRenderer;
	textarea: TextareaRenderable;
	completions?: readonly IoCompletionItem[];
	/** Character or line count that collapses a paste into a token. */
	pasteThreshold?: number;
	onPasteSummary?: (lines: number, characters: number) => void;
	onSubmit?: (text: string, mode: IoComposerMode, delivery: IoPromptDelivery) => void;
	onChange?: (text: string, mode: IoComposerMode) => void;
	onQueueChange?: (queue: readonly string[]) => void;
	historyLimit?: number;
}

const PLACEHOLDERS: Record<IoComposerMode, string> = {
	prompt: "Ask io…  (/help for commands)",
	shell: "Shell command…  (! runs it here)",
	command: "Command…  (/help lists commands)",
};

/** Prompt buffer state: modes, history, completion and queue. */
export class IoComposer {
	private readonly renderer: CliRenderer;
	readonly textarea: TextareaRenderable;
	private readonly onSubmit: ((text: string, mode: IoComposerMode, delivery: IoPromptDelivery) => void) | undefined;
	private readonly onChange: ((text: string, mode: IoComposerMode) => void) | undefined;
	private readonly onQueueChange: ((queue: readonly string[]) => void) | undefined;
	private readonly onPasteSummary: ((lines: number, characters: number) => void) | undefined;
	private readonly pasteThreshold: number;
	private readonly pasted = new Map<string, string>();
	private pasteCount = 0;
	private originalHandlePaste: ((event: unknown) => void) | undefined;
	private readonly historyLimit: number;
	private readonly history: string[] = [];
	private historyIndex = 0;
	private draft = "";
	private completions: readonly IoCompletionItem[];
	private queueItems: string[] = [];
	private mode: IoComposerMode = "prompt";

	constructor(options: IoComposerOptions) {
		this.renderer = options.renderer;
		this.textarea = options.textarea;
		this.onSubmit = options.onSubmit;
		this.onChange = options.onChange;
		this.onQueueChange = options.onQueueChange;
		this.onPasteSummary = options.onPasteSummary;
		this.pasteThreshold = Math.max(200, options.pasteThreshold ?? 2_000);
		this.historyLimit = Math.max(1, options.historyLimit ?? 100);
		this.completions = options.completions ?? [];
		this.updateMode();
		this.textarea.onContentChange = () => this.updateMode();
		this.textarea.onSubmit = () => {
			this.submit();
		};
		this.originalHandlePaste = this.textarea.handlePaste.bind(this.textarea) as (event: unknown) => void;
		this.textarea.handlePaste = ((event: { bytes: Uint8Array }) => {
			const text = new TextDecoder().decode(event.bytes);
			if (this.shouldSummarize(text)) this.insertPastedText(text);
			else this.originalHandlePaste?.(event);
		}) as typeof this.textarea.handlePaste;
	}

	get text(): string {
		return this.textarea.plainText;
	}

	get currentMode(): IoComposerMode {
		return this.mode;
	}

	get queued(): readonly string[] {
		return this.queueItems;
	}

	setText(text: string): void {
		this.pasted.clear();
		this.textarea.setText(text);
		this.updateMode();
		this.renderer.requestRender();
	}

	clear(): void {
		this.pasted.clear();
		this.textarea.clear();
		this.updateMode();
		this.renderer.requestRender();
	}

	addToHistory(text: string): void {
		const value = text.trim();
		if (!value) return;
		if (this.history.at(-1) === value) return;
		this.history.push(value);
		if (this.history.length > this.historyLimit) this.history.shift();
		this.historyIndex = this.history.length;
		this.draft = "";
	}

	historyPrevious(): boolean {
		if (this.history.length === 0) return false;
		if (this.historyIndex >= this.history.length) {
			this.draft = this.text;
			this.historyIndex = this.history.length - 1;
		} else if (this.historyIndex > 0) {
			this.historyIndex -= 1;
		}
		this.setText(this.history[this.historyIndex] ?? "");
		this.textarea.gotoBufferEnd();
		return true;
	}

	historyNext(): boolean {
		if (this.history.length === 0 || this.historyIndex >= this.history.length) return false;
		this.historyIndex += 1;
		const text = this.historyIndex >= this.history.length ? this.draft : (this.history[this.historyIndex] ?? "");
		this.setText(text);
		this.textarea.gotoBufferEnd();
		return true;
	}

	setCompletions(completions: readonly IoCompletionItem[]): void {
		this.completions = completions;
	}

	completion(): IoCompletionItem | undefined {
		const token = currentToken(this.text);
		if (!token || token.length < 2) return undefined;
		const normalized = token.toLowerCase();
		return this.completions.find((item) => item.value.toLowerCase().startsWith(normalized));
	}

	acceptCompletion(): boolean {
		const completion = this.completion();
		if (!completion) return false;
		const text = this.text;
		const token = currentToken(text);
		if (!token) return false;
		const start = text.length - token.length;
		const next = `${text.slice(0, start)}${completion.value} `;
		this.setText(next);
		this.textarea.gotoBufferEnd();
		return true;
	}

	paste(text: string): void {
		this.textarea.insertText(text);
		this.updateMode();
		this.renderer.requestRender();
	}

	submit(delivery: IoPromptDelivery = "steer"): boolean {
		const raw = this.text.trimEnd();
		if (raw.length === 0) return false;
		const text = this.expandPasted(raw);
		const mode = this.mode;
		this.addToHistory(text);
		this.onSubmit?.(text, mode, delivery);
		this.clear();
		return true;
	}

	queue(): number {
		const raw = this.text.trimEnd();
		if (raw.length === 0) return this.queueItems.length;
		const text = this.expandPasted(raw);
		this.queueItems = [...this.queueItems, text];
		this.clear();
		this.emitQueue();
		return this.queueItems.length;
	}

	editQueued(index: number, text: string): boolean {
		if (index < 0 || index >= this.queueItems.length) return false;
		this.queueItems = this.queueItems.map((item, current) => (current === index ? text : item));
		this.emitQueue();
		return true;
	}

	removeQueued(index: number): boolean {
		if (index < 0 || index >= this.queueItems.length) return false;
		this.queueItems = this.queueItems.filter((_, current) => current !== index);
		this.emitQueue();
		return true;
	}

	clearQueue(): void {
		if (this.queueItems.length === 0) return;
		this.queueItems = [];
		this.emitQueue();
	}

	setQueue(queue: readonly string[]): void {
		this.queueItems = [...queue];
		this.emitQueue();
	}

	dispose(): void {
		this.textarea.onContentChange = undefined;
		this.textarea.onSubmit = undefined;
		if (this.originalHandlePaste) this.textarea.handlePaste = this.originalHandlePaste as typeof this.textarea.handlePaste;
	}

	private updateMode(): void {
		const text = this.text;
		const next: IoComposerMode = text.startsWith("!") ? "shell" : text.startsWith("/") ? "command" : "prompt";
		if (next !== this.mode) {
			this.mode = next;
			this.textarea.placeholder = PLACEHOLDERS[next];
		}
		this.onChange?.(text, next);
	}

	/** Collapse a large paste into an editable token that expands on submit. */
	insertPastedText(text: string): string {
		const lines = text.split("\n").length;
		this.pasteCount += 1;
		const token = `[Pasted text #${this.pasteCount} · ${lines} lines]`;
		this.pasted.set(token, text);
		this.textarea.insertText(token);
		this.updateMode();
		this.onPasteSummary?.(lines, text.length);
		this.renderer.requestRender();
		return token;
	}

	private shouldSummarize(text: string): boolean {
		return text.length > this.pasteThreshold || text.split("\n").length > 12;
	}

	private expandPasted(text: string): string {
		let expanded = text;
		for (const [token, value] of this.pasted) expanded = expanded.split(token).join(value);
		return expanded;
	}

	private emitQueue(): void {
		this.onQueueChange?.(this.queueItems);
		this.renderer.requestRender();
	}
}

function currentToken(text: string): string {
	const match = /(?:^|\s)(\/[^\s]*|@[^\s]*|\S*\/\S*)$/.exec(text);
	return match?.[1] ?? "";
}
