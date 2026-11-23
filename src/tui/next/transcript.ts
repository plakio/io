import {
	BoxRenderable,
	MarkdownRenderable,
	SyntaxStyle,
	TextRenderable,
	type CliRenderer,
	type Renderable,
	type ScrollBoxRenderable,
} from "@opentui/core";
import type { IoEvent } from "../../engine/types.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoTranscriptOptions {
	renderer: CliRenderer;
	container: ScrollBoxRenderable;
	theme?: IoTheme;
	showThinking?: boolean;
}

type NoticeKind = "info" | "success" | "warning" | "error";

const THINKING_LABEL = "thinking";

function toolText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = part as { type?: unknown; text?: unknown };
			return value.type === "text" && typeof value.text === "string" ? value.text : "";
		})
		.filter((part) => part.length > 0)
		.join("\n");
}

function commandFromInput(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const command = (input as { command?: unknown }).command;
	return typeof command === "string" ? command : undefined;
}

function commandFromDelta(delta: string): string | undefined {
	try {
		const parsed = JSON.parse(delta) as unknown;
		return commandFromInput(parsed);
	} catch {
		return undefined;
	}
}

class AssistantBlock {
	readonly box: BoxRenderable;
	private readonly markdown: MarkdownRenderable;
	private readonly thinking: TextRenderable;
	private textValue = "";
	private thinkingValue = "";

	constructor(
		renderer: CliRenderer,
		theme: IoTheme,
		syntaxStyle: SyntaxStyle,
		showThinking: boolean,
	) {
		this.box = new BoxRenderable(renderer, {
			flexDirection: "column",
			marginBottom: 1,
			width: "100%",
		});
		this.markdown = new MarkdownRenderable(renderer, {
			content: "",
			syntaxStyle,
			fg: theme.text,
			bg: theme.background,
			conceal: true,
			streaming: true,
			width: "100%",
		});
		this.thinking = new TextRenderable(renderer, {
			content: "",
			fg: theme.muted,
			bg: theme.background,
			wrapMode: "word",
			visible: showThinking,
			marginBottom: 1,
		});
		this.box.add(this.thinking);
		this.box.add(this.markdown);
	}

	get text(): string {
		return this.textValue;
	}

	get thinkingText(): string {
		return this.thinkingValue;
	}

	setText(text: string, streaming: boolean): void {
		this.textValue = text;
		this.markdown.streaming = streaming;
		this.markdown.content = text;
	}

	setThinking(text: string, visible: boolean): void {
		this.thinkingValue = text;
		this.thinking.content = text.length > 0 ? `${THINKING_LABEL}\n${text}` : "";
		this.thinking.visible = visible && text.length > 0;
	}

	setThinkingVisible(visible: boolean): void {
		this.thinking.visible = visible && this.thinkingValue.length > 0;
	}

	setMarkdown(rendered: boolean): void {
		this.markdown.conceal = rendered;
	}

	finalize(): void {
		this.markdown.streaming = false;
	}
}

class ToolCard {
	readonly box: BoxRenderable;
	private readonly header: TextRenderable;
	private readonly command: TextRenderable;
	private readonly output: TextRenderable;
	private readonly theme: IoTheme;
	private name = "tool";
	private status: "running" | "success" | "error" = "running";
	private expanded = true;

	constructor(renderer: CliRenderer, theme: IoTheme, name: string) {
		this.theme = theme;
		this.name = name === "shell" ? "bash" : name;
		this.box = new BoxRenderable(renderer, {
			border: ["left"],
			borderColor: theme.border,
			paddingLeft: 1,
			marginBottom: 1,
			flexDirection: "column",
			width: "100%",
		});
		this.header = new TextRenderable(renderer, {
			content: "",
			fg: theme.accent,
			bg: theme.background,
			height: 1,
			wrapMode: "none",
		});
		this.command = new TextRenderable(renderer, {
			content: "",
			fg: theme.muted,
			bg: theme.background,
			wrapMode: "word",
		});
		this.output = new TextRenderable(renderer, {
			content: "",
			fg: theme.text,
			bg: theme.background,
			wrapMode: "word",
		});
		this.box.add(this.header);
		this.box.add(this.command);
		this.box.add(this.output);
		this.renderHeader();
	}

	setInput(input: unknown): void {
		const command = commandFromInput(input);
		if (!command) return;
		this.command.content = `$ ${command}`;
	}

	setDelta(delta: string): void {
		const command = commandFromDelta(delta);
		if (command) this.setInput({ command });
	}

	setProgress(): void {
		this.status = "running";
		this.renderHeader();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.command.visible = expanded;
		this.output.visible = expanded;
		this.renderHeader();
	}

	finish(status: "success" | "error", content: unknown): void {
		this.status = status;
		this.header.fg = status === "success" ? this.theme.success : this.theme.error;
		this.box.borderColor = status === "success" ? this.theme.border : this.theme.error;
		const text = toolText(content);
		if (text.length > 0) this.output.content = text.replace(/\n+$/, "");
		this.renderHeader();
	}

	private renderHeader(): void {
		const marker = this.expanded ? "▾" : "▸";
		this.header.content = `${marker} ${this.name} · ${this.status === "running" ? "running" : this.status === "success" ? "done" : "failed"}`;
	}
}

/**
 * Renders `IoEvent`s into the transcript. The view is deliberately independent
 * from the engine and from the old Pi message types.
 */
export class IoTranscript {
	private readonly renderer: CliRenderer;
	private readonly container: ScrollBoxRenderable;
	private readonly theme: IoTheme;
	private readonly syntaxStyle: SyntaxStyle;
	private readonly assistantBlocks = new Map<string, AssistantBlock>();
	private readonly toolCards = new Map<string, ToolCard>();
	private activeAssistant: AssistantBlock | undefined;
	private showThinking: boolean;
	private toolOutputExpanded = true;
	private markdownRendered = true;

	constructor(options: IoTranscriptOptions) {
		this.renderer = options.renderer;
		this.container = options.container;
		this.theme = options.theme ?? ioDarkTheme;
		this.showThinking = options.showThinking === true;
		this.syntaxStyle = SyntaxStyle.create(options.renderer.nativeScene);
	}

	get isEmpty(): boolean {
		return this.container.getChildrenCount() === 0;
	}

	addUser(text: string): void {
		const block = new BoxRenderable(this.renderer, {
			flexDirection: "column",
			marginBottom: 1,
			width: "100%",
		});
		block.add(
			new TextRenderable(this.renderer, {
				content: "user",
				fg: this.theme.accent,
				bg: this.theme.background,
				height: 1,
				wrapMode: "none",
			}),
		);
		block.add(
			new TextRenderable(this.renderer, {
				content: text,
				fg: this.theme.text,
				bg: this.theme.background,
				wrapMode: "word",
			}),
		);
		this.container.add(block);
		this.scrollToEnd();
		this.renderer.requestRender();
	}

	addNotice(message: string, kind: NoticeKind = "info"): void {
		const color =
			kind === "success"
				? this.theme.success
				: kind === "warning"
					? this.theme.warning
					: kind === "error"
						? this.theme.error
						: this.theme.muted;
		const notice = new TextRenderable(this.renderer, {
			content: `• ${message}`,
			fg: color,
			bg: this.theme.background,
			wrapMode: "word",
			marginBottom: 1,
		});
		this.container.add(notice);
		this.scrollToEnd();
		this.renderer.requestRender();
	}

	setShowThinking(visible: boolean): void {
		this.showThinking = visible;
		for (const block of this.assistantBlocks.values()) block.setThinkingVisible(visible);
		this.renderer.requestRender();
	}

	setMarkdown(rendered: boolean): void {
		this.markdownRendered = rendered;
		for (const block of this.assistantBlocks.values()) block.setMarkdown(rendered);
		this.renderer.requestRender();
	}

	addAssistant(text: string): void {
		if (!text.trim()) return;
		const messageID = `replay-${this.assistantBlocks.size + 1}`;
		const block = this.ensureAssistant(messageID);
		block.setText(text, false);
		block.finalize();
		this.renderer.requestRender();
	}

	setToolOutputExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		for (const card of this.toolCards.values()) card.setExpanded(expanded);
		this.renderer.requestRender();
	}

	apply(event: IoEvent): void {
		switch (event.type) {
			case "turn_started":
				this.activeAssistant = undefined;
				return;
			case "text_started": {
				const block = this.ensureAssistant(event.messageID);
				block.setText("", true);
				this.activeAssistant = block;
				return;
			}
			case "text_delta": {
				const block = this.assistantBlocks.get(event.messageID) ?? this.ensureAssistant(event.messageID);
				block.setText(this.textFor(event.messageID) + event.delta, true);
				this.activeAssistant = block;
				return;
			}
			case "text_ended": {
				const block = this.assistantBlocks.get(event.messageID);
				if (block) {
					block.setText(this.textFor(event.messageID), false);
					block.finalize();
				}
				if (this.activeAssistant === block) this.activeAssistant = undefined;
				return;
			}
			case "reasoning_started": {
				const block = this.ensureAssistant(event.messageID);
				block.setThinking("", this.showThinking);
				return;
			}
			case "reasoning_delta": {
				const block = this.ensureAssistant(event.messageID);
				const previous = this.thinkingFor(event.messageID);
				block.setThinking(previous + event.delta, this.showThinking);
				return;
			}
			case "reasoning_ended":
				return;
			case "tool_started": {
				const card = new ToolCard(this.renderer, this.theme, event.name);
				card.setExpanded(this.toolOutputExpanded);
				this.toolCards.set(event.toolCallID, card);
				this.container.add(card.box);
				this.scrollToEnd();
				this.renderer.requestRender();
				return;
			}
			case "tool_updated":
				this.toolCards.get(event.toolCallID)?.setDelta(event.delta ?? "");
				return;
			case "tool_called":
				this.toolCards.get(event.toolCallID)?.setInput(event.input);
				return;
			case "tool_progress":
				this.toolCards.get(event.toolCallID)?.setProgress();
				return;
			case "tool_finished": {
				const card = this.toolCards.get(event.toolCallID);
				if (card) card.finish(event.status, event.content);
				if (event.status === "error" && event.error) this.addNotice(event.error, "error");
				this.scrollToEnd();
				this.renderer.requestRender();
				return;
			}
			case "permission_requested":
				this.addNotice(`approval needed: ${event.request.resources.join(", ")}`, "warning");
				return;
			case "permission_resolved":
				this.addNotice(`approval ${event.decision}`, event.decision === "reject" ? "error" : "success");
				return;
			case "compaction_started":
				this.addNotice("compacting context…", "info");
				return;
			case "compaction_ended":
				this.addNotice("context compacted", "success");
				return;
			case "compaction_failed":
				this.addNotice(`compaction failed: ${event.error}`, "error");
				return;
			case "retry_scheduled":
				this.addNotice(`provider error; retrying in ${Math.max(1, Math.round(event.at / 1000))}s`, "warning");
				return;
			case "turn_ended":
				this.activeAssistant?.finalize();
				this.activeAssistant = undefined;
				return;
			case "idle":
				this.activeAssistant?.finalize();
				this.activeAssistant = undefined;
				return;
			case "error":
				this.addNotice(event.message, "error");
				return;
			default:
				return;
		}
	}

	clear(): void {
		clearChildren(this.container);
		this.assistantBlocks.clear();
		this.toolCards.clear();
		this.activeAssistant = undefined;
		this.renderer.requestRender();
	}

	dispose(): void {
		this.clear();
		this.syntaxStyle.destroy();
	}

	private ensureAssistant(messageID: string): AssistantBlock {
		const existing = this.assistantBlocks.get(messageID);
		if (existing) return existing;
		const block = new AssistantBlock(this.renderer, this.theme, this.syntaxStyle, this.showThinking);
		block.setMarkdown(this.markdownRendered);
		this.assistantBlocks.set(messageID, block);
		this.container.add(block.box);
		this.scrollToEnd();
		this.renderer.requestRender();
		return block;
	}

	private textFor(messageID: string): string {
		return this.assistantBlocks.get(messageID)?.text ?? "";
	}

	private thinkingFor(messageID: string): string {
		return this.assistantBlocks.get(messageID)?.thinkingText ?? "";
	}

	private scrollToEnd(): void {
		try {
			this.container.scrollTo(Infinity);
		} catch {
			// The scroll box may not have completed layout yet.
		}
	}
}


function clearChildren(container: Renderable): void {
	for (const child of [...container.getChildren()]) {
		container.remove(child);
		child.destroyRecursively();
	}
}
