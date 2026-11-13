import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	FooterComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	type AgentSession,
	type ModelRuntime,
	type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { FooterState, ToolResultLike } from "./components.js";

const ASSISTANT_UPDATE_INTERVAL_MS = 50;

/**
 * Pi marks assistant/user messages with iTerm2/FinalTerm prompt zones. IO is
 * not a shell, and Rex already tracks its own blocks, so keep the markers out
 * of the rendered stream while keeping Pi's component output intact.
 */
const ZONE_MARKER = /\x1b\]133;[ABC]\x07/g;
function withoutZones(line: string): string {
	return line.replace(ZONE_MARKER, "");
}

export class UserBlock extends UserMessageComponent {
	constructor(text: string) {
		super(text);
	}

	override render(width: number): string[] {
		return super.render(width).map(withoutZones);
	}
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n\n");
}

function extractThinking(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "thinking")
		.map((block) => (block.type === "thinking" ? block.thinking : ""))
		.join("\n\n")
		.trim();
}

/**
 * Adapter around Pi's AssistantMessageComponent. It keeps IO's throttling for
 * streaming updates and its thinking-visibility API, while Pi owns the actual
 * rendering (markdown theme, thinking block, error/abort notes).
 */
export class AssistantBlock implements Component {
	private readonly inner: AssistantMessageComponent;
	private readonly requestRender: () => void;
	private timer: NodeJS.Timeout | undefined;
	private pendingMessage: AssistantMessage | undefined;
	private pendingStreaming = false;
	private text = "";
	private thinking = "";
	private thinkingVisible = false;

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
		this.inner = new AssistantMessageComponent(undefined, true, undefined, "Thinking...", 0);
	}

	setMessage(message: AssistantMessage, streaming: boolean): void {
		this.pendingMessage = message;
		this.pendingStreaming = streaming;
		this.text = extractText(message);
		this.thinking = extractThinking(message);
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
		if (!this.pendingMessage) return;
		this.inner.updateContent(this.pendingMessage, this.pendingStreaming);
		this.requestRender();
	}

	getText(): string {
		return this.text;
	}

	getThinking(): string {
		return this.thinking;
	}

	getHasThinking(): boolean {
		return this.thinking.trim().length > 0;
	}

	setThinkingVisible(visible: boolean): void {
		if (this.thinkingVisible === visible) return;
		this.thinkingVisible = visible;
		this.inner.setHideThinkingBlock(!visible);
		this.requestRender();
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	render(width: number): string[] {
		return this.inner.render(width).map(withoutZones);
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}

type ToolDefinitionForRender = ConstructorParameters<typeof ToolExecutionComponent>[4];

export interface ToolBlockOptions {
	toolName: string;
	toolCallId: string;
	args: unknown;
	cwd: string;
	ui: TUI;
	toolDefinition?: ToolDefinitionForRender;
}

function toPiResult(
	result: ToolResultLike | undefined,
	isError: boolean,
	durationMs?: number,
): {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError: boolean;
	durationMs?: number;
} {
	let content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
	if (Array.isArray(result?.content)) {
		content = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	} else if (typeof result?.content === "string") {
		content = [{ type: "text", text: result.content }];
	}
	return { content, details: result?.details, isError, durationMs };
}

/** Adapter around Pi's ToolExecutionComponent, with IO's expansion contract. */
export class ToolBlock implements Component {
	private readonly inner: ToolExecutionComponent;
	private expanded = false;

	constructor(options: ToolBlockOptions) {
		this.inner = new ToolExecutionComponent(
			options.toolName,
			options.toolCallId,
			options.args,
			{ outputPad: 1 },
			options.toolDefinition,
			options.ui,
			options.cwd,
		);
	}

	markStarted(): void {
		this.inner.markExecutionStarted();
	}

	setPartial(result: ToolResultLike | undefined): void {
		if (!result) return;
		this.inner.updateResult(toPiResult(result, false), true);
	}

	setResult(result: ToolResultLike | undefined, isError: boolean, durationMs?: number): void {
		this.inner.updateResult(toPiResult(result, isError, durationMs), false);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.inner.setExpanded(expanded);
	}

	getExpanded(): boolean {
		return this.expanded;
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	render(width: number): string[] {
		return this.inner.render(width);
	}
}

/**
 * Transcript wrapper that owns the blank line before a tool panel. Hiding the
 * whole entry (low verbosity) also hides that separator, so no gaps remain.
 */
export class ToolEntry implements Component {
	private visible = true;

	constructor(
		private readonly block: ToolBlock,
		private readonly spaced: boolean,
	) {}

	setVisible(visible: boolean): void {
		this.visible = visible;
	}

	invalidate(): void {
		this.block.invalidate();
	}

	render(width: number): string[] {
		if (!this.visible) return [];
		const lines = this.block.render(width);
		return this.spaced ? ["", ...lines] : lines;
	}
}

/** Tokens per second on Pi's extension-status footer line. */
export function footerStatusText(state: FooterState): string | undefined {
	return state.speed;
}

/**
 * Pi's built-in footer: cwd + git branch on one line, token/context/cost and
 * model + thinking level on the next. IO's branch check is throttled by the
 * app; everything else comes from the session.
 */
export class Footer implements Component {
	private readonly inner: FooterComponent;
	private readonly runtime: ModelRuntime;
	private readonly footerData: ReadonlyFooterDataProvider;
	private branch: string | null = null;
	private state: FooterState = {};

	constructor(session: AgentSession, runtime: ModelRuntime) {
		this.runtime = runtime;
		this.footerData = {
			getGitBranch: () => this.branch,
			getExtensionStatuses: () => {
				const status = footerStatusText(this.state);
				return status ? new Map([["io", status]]) : new Map<string, string>();
			},
			getAvailableProviderCount: () =>
				new Set(this.runtime.getAvailableSnapshot().map((model) => model.provider)).size,
			onBranchChange: () => () => {},
		};
		this.inner = new FooterComponent(session, this.footerData);
	}

	setSession(session: AgentSession): void {
		this.inner.setSession(session);
	}

	setState(state: FooterState): void {
		this.branch = state.branch ?? null;
		this.state = state;
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	render(width: number): string[] {
		return this.inner.render(width);
	}
}
