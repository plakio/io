import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	Container,
	Markdown,
	Text,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	Key,
	type Component,
} from "@earendil-works/pi-tui";
import { formatDuration, formatUsage } from "../format.js";
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
 * Horizontal/vertical padding for overlay content. A full-width overlay clears
 * the base transcript behind it, avoiding stray text in the margins.
 */
export class PaddedBox implements Component {
	private readonly child: Component;
	private readonly paddingX: number;
	private readonly paddingY: number;

	constructor(child: Component, paddingX = 2, paddingY = 1) {
		this.child = child;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	invalidate(): void {
		this.child.invalidate();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - this.paddingX * 2);
		const lines = this.child.render(innerWidth).map((line) => `${" ".repeat(this.paddingX)}${line}`);
		const blank = " ".repeat(width);
		return [
			...Array.from({ length: this.paddingY }, () => blank),
			...lines,
			...Array.from({ length: this.paddingY }, () => blank),
		];
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
	queued?: number;
}

export class Footer implements Component {
	private state: FooterState = {};

	setState(state: FooterState): void {
		this.state = state;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const parts: string[] = [];
		if (this.state.modelRef) parts.push(style.bold(this.state.modelRef));
		let status = this.state.busy ? (this.state.status ?? "generating") : "ready";
		if ((this.state.queued ?? 0) > 0) status += ` · queued ${this.state.queued}`;
		parts.push(this.state.busy ? style.bold(status) : style.dim(status));
		const usage = formatUsage(this.state.usage);
		if (usage) parts.push(style.dim(usage));
		if (this.state.speed) parts.push(style.dim(this.state.speed));
		if (this.state.context) parts.push(style.dim(this.state.context));
		if (this.state.sessionId) parts.push(style.dim(`session ${this.state.sessionId.slice(0, 8)}`));

		const separator = style.dim(" · ");
		return [truncateToWidth(parts.join(separator), width, "…")];
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
		return lines;
	}
}
