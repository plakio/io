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
	onSubmit?: (text: string, mode: IoComposerMode, delivery: IoPromptDelivery) => void;
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
	private readonly onQueueChange: ((queue: readonly string[]) => void) | undefined;
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
		this.onQueueChange = options.onQueueChange;
		this.historyLimit = Math.max(1, options.historyLimit ?? 100);
		this.completions = options.completions ?? [];
		this.updateMode();
		this.textarea.onContentChange = () => this.updateMode();
		this.textarea.onSubmit = () => {
			this.submit();
		};
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
		this.textarea.setText(text);
		this.updateMode();
		this.renderer.requestRender();
	}

	clear(): void {
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
		const text = this.text.trimEnd();
		if (text.length === 0) return false;
		const mode = this.mode;
		this.addToHistory(text);
		this.onSubmit?.(text, mode, delivery);
		this.clear();
		return true;
	}

	queue(): number {
		const text = this.text.trimEnd();
		if (text.length === 0) return this.queueItems.length;
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
	}

	private updateMode(): void {
		const text = this.text;
		const next: IoComposerMode = text.startsWith("!") ? "shell" : text.startsWith("/") ? "command" : "prompt";
		if (next !== this.mode) {
			this.mode = next;
			this.textarea.placeholder = PLACEHOLDERS[next];
		}
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
