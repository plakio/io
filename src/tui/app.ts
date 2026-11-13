import type { AssistantMessage, ImageContent, Model, Usage } from "@earendil-works/pi-ai";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { collectImageAttachments } from "../images.js";
import { formatCwdForFooter } from "../format.js";
import {
	CombinedAutocompleteProvider,
	Container,
	Key,
	Loader,
	fuzzyFilter,
	getNativeClipboard,
	matchesKey,
	ProcessTerminal,
	SelectList,
	Spacer,
	Text,
	TuiMainScreen,
	stripTerminalSequences,
	type Component,
	type OverlayHandle,
	type ProgramStatus,
	type Terminal,
} from "@earendil-works/pi-tui";
import {
	ModelSelectorComponent,
	ThinkingSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent, ModelRuntime, SessionStats } from "@earendil-works/pi-coding-agent";
import type { IoConfig, IoPaths, PermissionMode, ThinkingLevel, Verbosity } from "../config.js";
import {
	ensureIoDirectories,
	loadConfig,
	PERMISSION_MODES,
	saveConfig,
	VERBOSITY_LEVELS,
} from "../config.js";
import { shellPatternFor } from "../safety.js";
import { formatContext, formatCount, formatSpeed, formatTokens, oneLine, shortSessionId } from "../format.js";
import { getGitDiff, getGitBranchAsync } from "../git-diff.js";
import { modelReference, parseModelReference, providerName } from "../providers.js";
import { refreshCatalogs, loadAvailableModels, reloadModelsJson, type AvailableModels } from "../runtime.js";
import { GITHUB_REPOSITORY, compareVersions, fetchLatestRelease, isHomebrewManaged } from "../update.js";
import {
	replaceHarnessSession,
	createSanitizedBashOperations,
	type ConfirmCommand,
	type Harness,
} from "../session.js";
import { VERSION } from "../version.js";
import {
	ConfirmOverlay,
	DynamicBorder,
	NoticeBlock,
	PaddedBox,
	ScopedModelsPicker,
	SessionPicker,
	modelSearchText,
} from "./components.js";
import { IoEditor } from "./editor.js";
import { AssistantBlock, Footer, ToolBlock, ToolEntry, UserBlock } from "./pi-components.js";
import { initPiVisuals, piAccent, piEditorTheme, piMuted } from "./pi-theme.js";
import { selectListTheme, style } from "./theme.js";

const HELP = `Commands

  /help            Show this help
  /model [ref]     Select a model, or set provider/model directly
  /models          List authenticated models
  /scope           Select models that Ctrl+P cycles through
  /effort [level]  Select or set thinking effort
  /thinking        Alias for /effort
  /verbosity [lvl] Set detail: low (hide tools), normal, high (thinking + expanded tools)
  /mode [ask|auto] Shell approval mode: confirm destructive commands, or run them
  /permissions     Alias for /mode
  /copy            Copy the last assistant response
  /debug           Write UI/session diagnostics to a log file
  /reload          Reload config, session resources, and model catalogs
  /update          Install the latest io release with Homebrew
  /editor          Compose the prompt in $EDITOR
  /diff [path]     Show git status, stat, and patch
  /session         Show session details and token usage
  /new             Start a new session
  /resume          Switch to an earlier session
  /fork            Fork from a previous message
  /compact         Compact the session context
  /name [text]     Name the current session
  /export [fmt]    Export the session (jsonl or html)
  /agent           Show the active agent
  /login           Show authentication instructions
  /logout          Show credential removal instructions
  /quit            Exit io

Keys

  Enter             Send prompt
  Shift+Enter       Insert newline (Ctrl+J also works)
  Esc or Ctrl+C     Cancel generation
  Ctrl+C twice      Exit when the prompt is empty
  Ctrl+O            Expand or collapse tool output
  Ctrl+T            Show or hide model reasoning
  Ctrl+G            Compose in your editor ($EDITOR → micro → nano → vim)

Approval prompt: ↑/↓ to choose, Enter to confirm, Esc to deny (default is deny).`;

/** Commands that are safe to run while the agent is streaming. */
const BUSY_SAFE_COMMANDS = new Set([
	"/help",
	"/session",
	"/diff",
	"/models",
	"/copy",
	"/debug",
	"/agent",
	"/login",
	"/logout",
	"/verbosity",
	"/quit",
	"/exit",
	"/q",
]);

/** Keep long sessions bounded; older rendered blocks are detached from the TUI. */
const MAX_TRANSCRIPT_CHILDREN = 500;

interface IoAppOptions {
	cwd: string;
	paths: IoPaths;
	runtime: ModelRuntime;
	harness: Harness;
	model: Model<any>;
	config: IoConfig;
	warnings?: string[];
	/** Inject a terminal for tests; defaults to the real process terminal. */
	terminal?: Terminal;
	/** Disable the background catalog refresh (tests/offline). */
	backgroundRefresh?: boolean;
	/** Override the model catalog (tests/embedders). */
	availableModels?: () => Promise<AvailableModels>;
}

function messageText(message: { content?: unknown }): string {
	const content = message.content;
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

function toolResultText(result: unknown): string {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block && typeof block === "object") {
				const typed = block as { type?: unknown; text?: unknown };
				if (typed.type === "text" && typeof typed.text === "string") return typed.text;
			}
			return "";
		})
		.filter((part) => part.length > 0)
		.join("\n");
}

export class IoApp {
	private options: IoAppOptions;
	private readonly tui: TuiMainScreen;
	private readonly header: Text;
	private readonly transcript: Container;
	private readonly editor: IoEditor;
	private readonly footer: Footer;
	private readonly statusContainer: Container;
	private statusLoader: Loader | undefined;
	private statusLoaderMessage: string | undefined;
	private statusLoaderPaused = false;
	private overlayDispose: (() => void) | undefined;
	private session: Harness["session"];
	private unsubscribe: (() => void) | undefined;
	private resolveExit: ((code: number) => void) | undefined;
	private exiting = false;
	private busy = false;
	private status: string | undefined;
	private queued = 0;
	private lastUsage: Usage | undefined;
	private lastDurationMs: number | undefined;
	private toolEntries: Array<{ block: ToolBlock; entry: ToolEntry; pinned: boolean }> = [];
	private transcriptPruneNoticeShown = false;
	private activeTools = new Map<string, ToolBlock>();
	private activeAssistant: AssistantBlock | undefined;
	private activeOverlay: OverlayHandle | undefined;
	private toolOutputExpanded = false;
	private cwdLabel = "";
	private branch: string | undefined;
	private lastBranchCheck = 0;
	private branchRefreshInFlight = false;
	private lastCtrlC = 0;
	private config: IoConfig;
	private verbosity: Verbosity = "normal";
	private thinkingVisible = false;
	private assistantBlocks: AssistantBlock[] = [];
	private lastAssistantText = "";
	private programDone = false;
	private programError: string | undefined;
	private statsCache: SessionStats | undefined;
	private statsAt = 0;
	private awaitingConfirm = false;
	private awaitingCommand = "";
	private awaitingSince = 0;
	private awaitingTimer: NodeJS.Timeout | undefined;
	private awaitingBellStage = 0;
	private permissionMode: PermissionMode = "ask";
	private bell = true;
	private toolFailures = 0;
	private lastProgramStatusJson = "";
	private lastProgress = false;
	private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	private spinnerIndex = 0;
	private spinnerTimer: NodeJS.Timeout | undefined;

	constructor(options: IoAppOptions) {
		initPiVisuals();
		this.options = options;
		this.session = options.harness.session;
		this.config = { ...options.config };
		this.verbosity = this.config.verbosity ?? "normal";
		this.permissionMode = options.harness.getPermissionMode();
		this.bell = this.config.bell !== false;
		this.thinkingVisible = this.verbosity === "high";
		this.toolOutputExpanded = this.verbosity === "high";
		this.cwdLabel = formatCwdForFooter(options.cwd, homedir());
		this.lastBranchCheck = 0;
		this.refreshGitBranch();
		this.tui = new TuiMainScreen(options.terminal ?? new ProcessTerminal());
		this.header = new Text(
			`${style.bold("io")}${style.dim(` ${VERSION}`)}\n${style.dim(options.cwd)}`,
			0,
			0,
		);
		this.transcript = new Container();
		this.statusContainer = new Container();
		this.editor = new IoEditor(this.tui, piEditorTheme());
		this.footer = new Footer(this.session, options.runtime);

		this.tui.addChild(this.header);
		this.tui.addChild(new Spacer(1));
		this.tui.addChild(this.transcript);
		this.tui.addChild(this.statusContainer);
		this.tui.addChild(new Spacer(1));
		this.tui.addChild(this.editor);
		this.tui.addChild(this.footer);
		this.tui.setFocus(this.editor);
		this.editor.onSubmit = (text) => this.handleSubmit(text);
		this.updateAgentAutocomplete();
		this.tui.addInputListener((data) => this.handleGlobalInput(data));
	}

	async run(): Promise<number> {
		this.renderInitialState();
		this.subscribe();
		this.tui.start();
		this.updateFooterAndTitle();
		// Merge fresh provider catalogs in the background (like Pi), so new
		// models appear in /model without a manual refresh. Never blocks
		// the first paint; the picker just sees the snapshot at open time.
		if (this.options.backgroundRefresh !== false) {
			void refreshCatalogs(this.options.runtime, undefined, { force: false });
		}
		this.tui.requestRender();

		return new Promise<number>((resolve) => {
			this.resolveExit = resolve;
		});
	}

	private subscribe(): void {
		this.unsubscribe?.();
		this.unsubscribe = this.session.subscribe((event) => {
			try {
				this.handleEvent(event);
			} catch (error) {
				this.addNotice(`internal event error: ${(error as Error).message}`, { dim: true });
			}
		});
	}

	private renderInitialState(): void {
		for (const warning of this.options.warnings ?? []) {
			this.addNotice(`warning: ${warning}`, { dim: true });
		}
		if (this.options.harness.modelFallbackMessage) {
			this.addNotice(`warning: ${this.options.harness.modelFallbackMessage}`, { dim: true });
		}
		if (this.options.harness.resumed) {
			this.addNotice(
				`resumed session ${shortSessionId(this.session.sessionId)} · ${this.options.cwd}`,
				{ dim: true },
			);
		}

		const messages = this.session.messages;
		const start = Math.max(0, messages.length - 80);
		for (const message of messages.slice(start)) {
			if (message.role === "user") {
				const text = messageText(message);
				if (text.trim()) {
					this.editor.addToHistory(text);
					this.addBlock(new UserBlock(text));
				}
			} else if (message.role === "assistant") {
				const block = new AssistantBlock(() => this.tui.requestRender());
				block.setMessage(message, false);
				block.setThinkingVisible(this.thinkingVisible);
				if (block.getText().trim()) this.addBlock(block);
				this.assistantBlocks.push(block);
				const assistant = message as AssistantMessage;
				if (assistant.usage) {
					this.lastUsage = assistant.usage;
					this.lastDurationMs = assistant.durationMs;
				}
			}
		}
		if (start > 0) {
			this.addNotice(`… ${start} older messages hidden; full context is still available to the model`, {
				dim: true,
			});
		}
		if (this.permissionMode === "auto") {
			this.addNotice(
				"permission mode: auto — destructive shell commands run without confirmation. Built-in deny rules for credential files still apply. Use /mode ask to restore.",
				{ bold: true },
			);
		}
		if (this.config.bell === false) {
			this.addNotice("terminal bell disabled (bell: false)", { dim: true });
		}
		this.addNotice("type /help for commands", { dim: true });
	}

	private addBlock(component: Component, options: { spacing?: boolean } = {}): void {
		if (options.spacing !== false && this.transcript.children.length > 0) {
			this.transcript.addChild(new Spacer(1));
		}
		this.transcript.addChild(component);
		this.pruneTranscript();
		this.tui.requestRender();
	}

	private addToolEntry(block: ToolBlock, options: { pinned?: boolean } = {}): ToolEntry {
		const entry = new ToolEntry(block, this.transcript.children.length > 0);
		entry.setVisible(this.verbosity !== "low" || options.pinned === true);
		this.transcript.addChild(entry);
		this.toolEntries.push({ block, entry, pinned: options.pinned === true });
		this.pruneTranscript();
		this.tui.requestRender();
		return entry;
	}

	private pruneTranscript(): void {
		if (this.transcript.children.length <= MAX_TRANSCRIPT_CHILDREN) return;
		while (this.transcript.children.length > MAX_TRANSCRIPT_CHILDREN) {
			const oldest = this.transcript.children[0];
			if (!oldest) break;
			this.transcript.removeChild(oldest);
		}
		const live = new Set(this.transcript.children);
		this.toolEntries = this.toolEntries.filter((entry) => live.has(entry.entry));
		this.assistantBlocks = this.assistantBlocks.filter((block) => live.has(block));
		if (!this.transcriptPruneNoticeShown) {
			this.transcriptPruneNoticeShown = true;
			this.transcript.addChild(new Spacer(1));
			this.transcript.addChild(
				new NoticeBlock("older transcript blocks hidden; the full context is still available to the model", {
					dim: true,
				}),
			);
		}
	}

	private addNotice(text: string, options: { dim?: boolean; bold?: boolean } = {}): void {
		this.addBlock(new NoticeBlock(text, options));
	}

	/** Notice channel for the session layer (blocked subagent commands, etc.). */
	notify(message: string): void {
		this.addNotice(`⚠ ${message}`, { bold: true });
	}

	/**
	 * A failed tool call is otherwise only visible inside the tool panel, where
	 * a retry loop turns into a wall of dim text. Always leave one line behind.
	 */
	private reportToolFailure(toolName: string, result: unknown): void {
		const text = toolResultText(result);
		const exit = /Command exited with code (\d+)/.exec(text)?.[1];
		const first = text
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0 && !/^Command exited with code \d+$/.test(line));
		// A blocked command already left an approval record; do not repeat it.
		if (/denied permission|Blocked by io permissions|no way to ask the user for approval/.test(text)) return;
		const parts = [`${toolName} failed`];
		if (exit) parts.push(`(exit ${exit})`);
		if (first) parts.push(`· ${oneLine(first, 120)}`);
		this.toolFailures += 1;
		this.addNotice(`✖ ${parts.join(" ")}`, { bold: true });
	}

	private handleEvent(event: AgentSessionEvent): void {
		if (this.exiting) return;
		switch (event.type) {
			case "agent_start":
				this.busy = true;
				this.programDone = false;
				this.programError = undefined;
				this.toolFailures = 0;
				this.status = "generating";
				this.lastUsage = undefined;
				this.lastDurationMs = undefined;
				this.statsCache = undefined;
				this.statsAt = 0;
				this.updateFooterAndTitle();
				break;
			case "agent_end":
				if (!this.busy) this.busy = true;
				break;
			case "agent_settled":
				this.busy = false;
				this.status = undefined;
				if (this.toolFailures > 0 && !this.programError) {
					this.programError = this.toolFailures === 1 ? "1 command failed" : `${this.toolFailures} commands failed`;
				}
				if (!this.programError) this.programDone = true;
				this.activeAssistant?.dispose();
				this.activeAssistant = undefined;
				this.updateFooterAndTitle();
				break;
			case "message_start":
				if (event.message.role === "user") {
					const text = messageText(event.message);
					if (text.trim()) this.addBlock(new UserBlock(text));
				} else if (event.message.role === "assistant") {
					const block = new AssistantBlock(() => this.tui.requestRender());
					block.setMessage(event.message, true);
					block.setThinkingVisible(this.thinkingVisible);
					this.addBlock(block);
					this.activeAssistant = block;
					this.assistantBlocks.push(block);
				}
				break;
			case "message_update":
				if (event.message.role === "assistant" && this.activeAssistant) {
					this.activeAssistant.setMessage(event.message, true);
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					const assistant = event.message as AssistantMessage;
					this.activeAssistant?.setMessage(assistant, false);
					this.activeAssistant = undefined;
					const response = messageText(event.message).trim();
					if (response.length > 0) this.lastAssistantText = response;
					if (assistant.usage) {
						this.lastUsage = assistant.usage;
						this.lastDurationMs = assistant.durationMs;
					}
					this.statsCache = undefined;
					this.statsAt = 0;
					if (assistant.stopReason === "error") {
						this.programError = oneLine(assistant.errorMessage || "unknown error", 120);
					} else if (assistant.stopReason === "aborted") {
						this.programDone = false;
					}
					this.updateFooterAndTitle();
				}
				break;
			case "tool_execution_start": {
				const command =
					typeof event.args === "object" && event.args !== null && "command" in event.args
						? String((event.args as { command?: unknown }).command ?? "")
						: (JSON.stringify(event.args) ?? String(event.args));
				const block = new ToolBlock({
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					args: event.args,
					cwd: this.options.cwd,
					ui: this.tui,
					toolDefinition: this.options.harness.tools.find((tool) => tool.name === event.toolName),
				});
				block.setExpanded(this.toolOutputExpanded);
				block.markStarted();
				this.addToolEntry(block);
				this.activeTools.set(event.toolCallId, block);
				this.status = this.toolStatusLabel(event.toolName, command);
				this.updateFooterAndTitle();
				break;
			}
			case "tool_execution_update": {
				this.activeTools.get(event.toolCallId)?.setPartial(event.partialResult);
				break;
			}
			case "tool_execution_end": {
				const block = this.activeTools.get(event.toolCallId);
				block?.setResult(event.result, event.isError, event.durationMs);
				this.activeTools.delete(event.toolCallId);
				if (event.isError) {
					this.reportToolFailure(event.toolName, event.result);
				}
				this.status = this.busy ? "generating" : undefined;
				this.updateFooterAndTitle();
				break;
			}
			case "auto_retry_start":
				this.status = `retrying (${event.attempt}/${event.maxAttempts})`;
				this.addNotice(`provider error; retrying in ${Math.ceil(event.delayMs / 1000)}s (${event.attempt}/${event.maxAttempts})`, {
					dim: true,
				});
				this.updateFooterAndTitle();
				break;
			case "auto_retry_end":
				if (!event.success) {
					this.programError = oneLine(event.finalError ?? "retry failed", 120);
					this.addNotice(`retry failed: ${event.finalError ?? "unknown error"}`, { bold: true });
					this.updateFooterAndTitle();
				}
				break;
			case "compaction_start":
				this.status = "compacting context";
				this.addNotice("compacting context…", { dim: true });
				this.updateFooterAndTitle();
				break;
			case "compaction_end":
				this.status = this.busy ? "generating" : undefined;
				if (event.result) {
					this.addNotice("context compacted", { dim: true });
				} else if (event.errorMessage) {
					this.programError = oneLine(event.errorMessage, 120);
					this.addNotice(`compaction failed: ${event.errorMessage}`, { bold: true });
				}
				this.updateFooterAndTitle();
				break;
			case "queue_update":
				this.queued = event.steering.length + event.followUp.length;
				if (this.queued === 0 && this.busy && this.status === "queued") this.status = "generating";
				this.updateFooterAndTitle();
				break;
			case "session_info_changed":
			case "thinking_level_changed":
			case "entry_appended":
				break;
			default:
				break;
		}
	}

	private updateTerminalTitle(): void {
		// OSC 0 window/tab text only. Rex does not derive its tab icon from this
		// string: the icon comes from OSC 7501 Program Status (see
		// updateProgramStatus), and the ⏳/✓ glyphs here are font-dependent
		// (they can render as tofu in terminals without an emoji font). The
		// title is kept for window titlebars and non-Rex terminals.
		const model = this.session.model ?? this.options.model;
		const marker = this.programError ? "✗" : this.busy ? "⏳" : "✓";
		const parts = ["io"];
		if (model) parts.push(`${model.provider}/${model.id}`);
		const cwd = this.options.cwd;
		if (cwd && cwd !== "/") {
			const short = cwd.split("/").filter(Boolean).slice(-2).join("/");
			if (short) parts.push(short);
		}
		this.tui.terminal.setTitle(`${marker} ${parts.join(" · ")}`);
	}

	private updateProgramStatus(): void {
		// OSC 7501 (Rex Program Status) + OSC 9;4 terminal progress. Pi does
		// the same via ProgramStatusReporter: blocked wins over working, and
		// done/error latch until the next run. Writes are deduplicated so
		// frequent footer updates do not spam the terminal; the terminal
		// itself no-ops when the terminal never confirmed OSC 7501 support.
		const streaming = this.busy || this.session.isStreaming;
		let status: ProgramStatus;
		if (this.awaitingConfirm) {
			status = { state: "blocked", kind: "permission", app: "io", message: "confirmation needed" };
		} else if (streaming) {
			status = { state: "working", app: "io", message: this.status ?? "working" };
		} else if (this.programError) {
			status = { state: "error", app: "io", message: this.programError };
		} else if (this.programDone) {
			status = { state: "done", app: "io", message: "done" };
		} else {
			status = { state: "idle", app: "io" };
		}
		const key = JSON.stringify(status);
		if (key !== this.lastProgramStatusJson) {
			this.lastProgramStatusJson = key;
			this.tui.terminal.setProgramStatus(status);
		}
		if (streaming !== this.lastProgress) {
			this.lastProgress = streaming;
			this.tui.terminal.setProgress(streaming);
		}
	}

	private updateSpinnerTimer(): void {
		const active = this.busy || this.session.isStreaming;
		if (active && this.spinnerTimer === undefined) {
			this.spinnerTimer = setInterval(() => {
				if (!this.busy && !this.session.isStreaming) {
					if (this.spinnerTimer !== undefined) clearInterval(this.spinnerTimer);
					this.spinnerTimer = undefined;
					this.spinnerIndex = 0;
					this.updateFooter();
					return;
				}
				this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
				this.updateFooter();
			}, 80);
			this.spinnerTimer.unref?.();
		} else if (!active && this.spinnerTimer !== undefined) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = undefined;
			this.spinnerIndex = 0;
		}
	}

	private updateFooterAndTitle(): void {
		this.updateFooter();
		this.updateWorkingIndicator();
		this.updateTerminalTitle();
		this.updateProgramStatus();
		this.updateSpinnerTimer();
	}

	/**
	 * Pi-style braille spinner above the editor while work is in flight. While
	 * IO is blocked on an approval the spinner stops and the line says so: a
	 * spinning "running shell" is exactly what made a pending prompt look like
	 * a hung session.
	 */
	private updateWorkingIndicator(): void {
		const active = this.busy || this.session.isStreaming || this.status !== undefined || this.awaitingConfirm;
		if (!active) {
			if (!this.statusLoader) return;
			this.statusLoader.stop();
			this.statusContainer.clear();
			this.statusLoader = undefined;
			this.statusLoaderMessage = undefined;
			this.tui.requestRender();
			return;
		}
		// Swap the spinner for a static ⏸ when IO is blocked on the user: a
		// spinning indicator reads as "still working".
		if (this.statusLoader && this.statusLoaderPaused !== this.awaitingConfirm) {
			this.statusLoaderPaused = this.awaitingConfirm;
			this.statusLoader.setIndicator(
				this.awaitingConfirm ? { frames: ["⏸"], intervalMs: 0 } : { frames: this.spinnerFrames, intervalMs: 80 },
			);
		}
		const message = this.awaitingConfirm
			? this.awaitingMessage()
			: this.status
				? this.status.charAt(0).toUpperCase() + this.status.slice(1)
				: "Working";
		if (!this.statusLoader) {
			this.statusLoaderPaused = this.awaitingConfirm;
			this.statusLoader = new Loader(
				this.tui,
				piAccent,
				piMuted,
				message,
				this.awaitingConfirm ? { frames: ["⏸"], intervalMs: 0 } : { intervalMs: 80 },
			);
			this.statusLoaderMessage = message;
			this.statusContainer.addChild(this.statusLoader);
			this.statusLoader.start();
			return;
		}
		if (message !== this.statusLoaderMessage) {
			this.statusLoaderMessage = message;
			this.statusLoader.setMessage(message);
		}
	}

	/** Line above the editor while a confirmation is open. */
	private awaitingMessage(): string {
		const elapsed = Math.floor((Date.now() - this.awaitingSince) / 1000);
		const suffix = elapsed >= 5 ? ` (${elapsed}s)` : "";
		return `Waiting for approval${suffix}: ${oneLine(this.awaitingCommand, 60)} — ↑/↓ then Enter (default: deny)`;
	}

	private ringBell(): void {
		if (!this.bell || !process.stdout.isTTY) return;
		try {
			process.stdout.write("\x07");
		} catch {
			// A closed stdout is handled by the process-level EPIPE guard.
		}
	}

	private startAwaitingTimer(): void {
		this.awaitingSince = Date.now();
		this.awaitingBellStage = 0;
		if (this.awaitingTimer !== undefined) clearInterval(this.awaitingTimer);
		this.awaitingTimer = setInterval(() => {
			if (!this.awaitingConfirm) return;
			const elapsed = Date.now() - this.awaitingSince;
			if (this.awaitingBellStage === 0 && elapsed >= 30_000) {
				this.awaitingBellStage = 1;
				this.ringBell();
			} else if (this.awaitingBellStage === 1 && elapsed >= 90_000) {
				this.awaitingBellStage = 2;
				this.ringBell();
			}
			this.updateWorkingIndicator();
			this.tui.requestRender();
		}, 1000);
		this.awaitingTimer.unref?.();
	}

	private stopAwaitingTimer(): void {
		if (this.awaitingTimer === undefined) return;
		clearInterval(this.awaitingTimer);
		this.awaitingTimer = undefined;
	}

	private toolStatusLabel(toolName: string, _command: string): string {
		if (toolName === "bash" || toolName.includes("shell")) return "running shell";
		if (toolName === "subagent") return "running subagent";
		return `running ${toolName}`;
	}

	private refreshGitBranch(): void {
		const now = Date.now();
		if (this.branchRefreshInFlight || now - this.lastBranchCheck < 10_000) return;
		this.lastBranchCheck = now;
		this.branchRefreshInFlight = true;
		void getGitBranchAsync(this.options.cwd)
			.then((branch) => {
				if (branch === this.branch) return;
				this.branch = branch;
				this.updateFooter();
			})
			.finally(() => {
				this.branchRefreshInFlight = false;
			});
	}

	private getStats(): SessionStats {
		const now = Date.now();
		if (!this.statsCache || now - this.statsAt > 1_000) {
			this.statsCache = this.session.getSessionStats();
			this.statsAt = now;
		}
		return this.statsCache;
	}

	private updateFooter(): void {
		const model = this.session.model ?? this.options.model;
		const stats = this.getStats();
		const streaming = this.busy || this.session.isStreaming;
		const totals = stats.tokens;
		const promptDenominator = totals.input + totals.cacheRead + totals.cacheWrite;
		this.refreshGitBranch();
		this.footer.setState({
			cwd: this.cwdLabel,
			branch: this.branch,
			modelRef: model ? modelReference(model as Model<any>) : undefined,
			usage: this.lastUsage,
			speed: this.lastUsage ? formatSpeed(this.lastUsage.output, this.lastDurationMs) : undefined,
			context: formatContext(stats.contextUsage),
			sessionId: this.session.sessionId,
			busy: this.busy,
			status: this.status,
			spinner: streaming ? this.spinnerFrames[this.spinnerIndex] : undefined,
			queued: this.queued,
			permissionMode: this.permissionMode,
			totals,
			cost: stats.cost > 0 ? stats.cost : undefined,
			cacheHit: promptDenominator > 0 ? (totals.cacheRead / promptDenominator) * 100 : undefined,
		});
		this.tui.requestRender();
	}

	private handleGlobalInput(data: string): { consume?: boolean } | undefined {
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.activeOverlay) return undefined;
			if (this.busy || this.session.isStreaming) {
				this.lastCtrlC = Date.now();
				void this.cancelGeneration();
				return { consume: true };
			}
			if (this.editor.getText().length > 0) {
				this.editor.setText("");
				return { consume: true };
			}
			const now = Date.now();
			if (now - this.lastCtrlC < 1500) {
				this.exit(0);
			} else {
				this.lastCtrlC = now;
				this.status = "press ctrl+c again to exit";
				this.updateFooterAndTitle();
				setTimeout(() => {
					if (!this.busy && this.status === "press ctrl+c again to exit") {
						this.status = undefined;
						this.updateFooterAndTitle();
					}
				}, 2000).unref?.();
			}
			return { consume: true };
		}

		if (matchesKey(data, Key.escape)) {
			if (this.activeOverlay) return undefined;
			if (this.busy || this.session.isStreaming) {
				void this.cancelGeneration();
				return { consume: true };
			}
			return undefined;
		}

		if (matchesKey(data, Key.ctrl("p"))) {
			if (this.activeOverlay) return undefined;
			if (this.busy || this.session.isStreaming) return undefined;
			void this.cycleModel("forward");
			return { consume: true };
		}

		if (matchesKey(data, Key.ctrlShift("p"))) {
			if (this.activeOverlay) return undefined;
			if (this.busy || this.session.isStreaming) return undefined;
			void this.cycleModel("backward");
			return { consume: true };
		}

		if (matchesKey(data, Key.shift("tab"))) {
			if (this.activeOverlay) return undefined;
			if (this.busy) return undefined;
			const level = this.session.cycleThinkingLevel();
			if (level) {
				this.addNotice(`effort: ${level}`, { dim: true });
				this.config = { ...this.config, thinkingLevel: level };
				try {
					saveConfig(this.options.paths, this.config);
				} catch (error) {
					this.addNotice(`warning: could not save effort preference: ${(error as Error).message}`, {
						bold: true,
					});
				}
			}
			return { consume: true };
		}

		if (matchesKey(data, Key.alt("enter"))) {
			if (this.activeOverlay) return undefined;
			if (this.busy || this.session.isStreaming) {
				const text = this.editor.getText();
				if (text.trim().length === 0) {
					this.addNotice("Type your follow-up now; it will be sent when the current response finishes.", {
						dim: true,
					});
					return { consume: true };
				}
				this.editor.setText("");
				void this.session.prompt(text, { streamingBehavior: "followUp" }).catch((error) => {
					this.addNotice(`could not queue follow-up: ${(error as Error).message}`, { bold: true });
				});
				this.addNotice("follow-up queued", { dim: true });
				return { consume: true };
			}
			return undefined;
		}

		if (matchesKey(data, Key.alt("up"))) {
			if (this.activeOverlay) return undefined;
			const queued = this.session.clearQueue();
			const combined = [...queued.steering, ...queued.followUp].join("\n\n");
			if (combined) {
				this.editor.setText(combined);
				this.addNotice("queued messages restored to the editor", { dim: true });
			}
			this.queued = 0;
			this.updateFooterAndTitle();
			return { consume: true };
		}

		if (matchesKey(data, Key.ctrl("o"))) {
			if (this.activeOverlay) return undefined;
			this.toolOutputExpanded = !this.toolOutputExpanded;
			for (const { block } of this.toolEntries) block.setExpanded(this.toolOutputExpanded);
			this.status = this.toolOutputExpanded ? "tool output expanded" : "tool output collapsed";
			this.updateFooterAndTitle();
			setTimeout(() => {
				if (this.status === "tool output expanded" || this.status === "tool output collapsed") {
					this.status = this.busy ? "generating" : undefined;
					this.updateFooterAndTitle();
				}
			}, 1500).unref?.();
			return { consume: true };
		}

		if (matchesKey(data, Key.ctrl("t"))) {
			if (this.activeOverlay) return undefined;
			this.thinkingVisible = !this.thinkingVisible;
			for (const block of this.assistantBlocks) block.setThinkingVisible(this.thinkingVisible);
			this.status = this.thinkingVisible ? "thinking shown" : "thinking hidden";
			this.updateFooterAndTitle();
			setTimeout(() => {
				if (this.status === "thinking shown" || this.status === "thinking hidden") {
					this.status = this.busy ? "generating" : undefined;
					this.updateFooterAndTitle();
				}
			}, 1500).unref?.();
			return { consume: true };
		}

		if (matchesKey(data, Key.ctrl("g"))) {
			if (this.activeOverlay) return undefined;
			if (this.busy || this.session.isStreaming) {
				this.addNotice("Wait for the current response to finish before opening the editor.", { dim: true });
				return { consume: true };
			}
			void this.openExternalEditor();
			return { consume: true };
		}

		if (matchesKey(data, Key.ctrl("d")) && !this.activeOverlay) {
			if (!this.busy && this.editor.getText().length === 0) {
				this.exit(0);
				return { consume: true };
			}
		}
		return undefined;
	}

	private async sendPrompt(text: string, options: { followUp?: boolean; images?: ImageContent[] } = {}): Promise<void> {
		// While the agent is streaming, Pi requires an explicit queue behavior.
		// Always use followUp here so ordinary Enter submissions accumulate
		// instead of failing (or interrupting) the current turn.
		const streaming = this.session.isStreaming;
		const promptOptions = {
			...(streaming || options.followUp ? { streamingBehavior: "followUp" as const } : {}),
			...(options.images && options.images.length > 0 ? { images: options.images } : {}),
		};
		try {
			if (streaming) {
				this.status = "queued";
				this.addNotice(`queued: ${oneLine(text, 80)}`, { dim: true });
				this.updateFooterAndTitle();
			}
			await this.session.prompt(text, promptOptions);
		} catch (error) {
			if (!this.session.isStreaming) {
				this.busy = false;
				this.activeAssistant?.dispose();
				this.activeAssistant = undefined;
			}
			this.addNotice(`error: ${(error as Error).message}`, { bold: true });
			this.status = undefined;
			this.updateFooterAndTitle();
		}
	}

	private handleSubmit(text: string): void {
		if (this.exiting) return;
		const prompt = text;
		if (prompt.trim().length === 0) return;
		this.editor.setText("");
		this.editor.addToHistory(prompt);
		if (prompt.trimStart().startsWith("/")) {
			void this.handleCommand(prompt.trim());
			return;
		}
		if (prompt.trimStart().startsWith("!")) {
			void this.runInlineShell(prompt.trimStart(), { pinned: true });
			return;
		}
		const attachments = collectImageAttachments(prompt, this.options.cwd);
		if (attachments.length > 0) {
			const names = attachments.map((attachment) => attachment.path.split("/").pop() ?? attachment.path);
			this.addNotice(`attached ${names.join(", ")}`, { dim: true });
		}
		void this.sendPrompt(prompt, {
			images: attachments.map((attachment) => attachment.content),
		});
	}

	private async runInlineShell(text: string, options: { status?: string; pinned?: boolean } = {}): Promise<boolean> {
		if (this.busy || this.session.isStreaming) {
			this.addNotice("Wait for the current response to finish before running a shell command.", { dim: true });
			this.editor.setText(text);
			return false;
		}
		const excluded = text.startsWith("!!");
		const command = text.slice(excluded ? 2 : 1).trim();
		if (command.length === 0) {
			this.addNotice("usage: `!command` includes output in context, `!!command` does not", { dim: true });
			return false;
		}
		this.status = options.status ?? "running shell";
		this.updateFooterAndTitle();
		const started = Date.now();
		const block = new ToolBlock({
			toolName: "bash",
			toolCallId: `inline-${Date.now()}`,
			args: { command },
			cwd: this.options.cwd,
			ui: this.tui,
			toolDefinition: this.options.harness.tools.find((tool) => tool.name === "bash"),
		});
		block.markStarted();
		this.addToolEntry(block, { pinned: options.pinned });
		let output = "";
		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					output += chunk;
					block.setPartial({ content: [{ type: "text", text: output }] });
				},
				{
					excludeFromContext: excluded,
					operations: createSanitizedBashOperations(this.options.paths),
				},
			);
			const durationMs = Date.now() - started;
			const isError = (result.exitCode ?? 0) !== 0 || result.cancelled;
			const details: Record<string, unknown> = {};
			if (result.fullOutputPath) details.fullOutputPath = result.fullOutputPath;
			block.setResult(
				{ content: [{ type: "text", text: result.output || output }], details },
				isError,
				durationMs,
			);
			this.updateFooterAndTitle();
			return !isError;
		} catch (error) {
			block.setResult(undefined, true, Date.now() - started);
			this.addNotice(`could not run shell command: ${(error as Error).message}`, { bold: true });
			return false;
		}
	}

	private async handleCommand(input: string): Promise<void> {
		const space = input.indexOf(" ");
		const command = space === -1 ? input : input.slice(0, space);
		const argument = space === -1 ? "" : input.slice(space + 1).trim();
		if ((this.busy || this.session.isStreaming) && !BUSY_SAFE_COMMANDS.has(command)) {
			this.addNotice("Wait for the current response to finish before changing session state.", {
				dim: true,
			});
			return;
		}
		switch (command) {
			case "/help":
				this.addNotice(HELP, { dim: true });
				return;
			case "/agent":
				this.addNotice(`agent: ${this.options.harness.agent.id} (${this.options.harness.agent.name})`, { dim: true });
				return;
			case "/quit":
			case "/exit":
			case "/q":
				this.exit(0);
				return;
			case "/model":
				if (!argument) {
					await this.showModelPicker();
				} else {
					await this.setModelByReference(argument);
				}
				return;
			case "/scope":
				await this.showScopePicker();
				return;
			case "/effort":
			case "/thinking":
				if (!argument) {
					await this.showEffortSelector();
				} else {
					await this.applyEffort(argument);
				}
				return;
			case "/compact":
				await this.compactSession();
				return;
			case "/new":
				await this.newSession();
				return;
			case "/resume":
				await this.resumeSession();
				return;
			case "/reload":
				await this.reloadResources();
				return;
			case "/update":
				await this.checkForUpdate();
				return;
			case "/editor":
				void this.openExternalEditor();
				return;
			case "/name":
				if (!argument) {
					this.addNotice("usage: /name <name>", { dim: true });
				} else {
					this.setSessionName(argument);
				}
				return;
			case "/export":
				await this.exportSession(argument || undefined);
				return;
			case "/fork":
				await this.forkSession();
				return;
			case "/models":
				await this.listModels();
				return;
			case "/diff":
				await this.showDiff(argument || undefined);
				return;
			case "/verbosity": {
				if (!argument) {
					this.addNotice(
						`verbosity: ${this.verbosity} (low | normal | high)\nlow hides tool panels; normal collapses them; high shows thinking and expanded tools.`,
						{ dim: true },
					);
					return;
				}
				const level = argument.toLowerCase() as Verbosity;
				if (!(VERBOSITY_LEVELS as readonly string[]).includes(level)) {
					this.addNotice("usage: /verbosity [low|normal|high]", { bold: true });
					return;
				}
				this.applyVerbosity(level);
				return;
			}
			case "/mode":
			case "/permissions":
				if (!argument) {
					this.addNotice(
						[
							`permission mode: ${this.permissionMode}`,
							"",
							"ask   confirm destructive shell commands before running them (default)",
							"auto  run them without confirmation; built-in denies for credential files still apply",
							"",
							"Switch with /mode ask or /mode auto. The choice is saved to config.json; per-command rules stay in `permissions`.",
						].join("\n"),
						{ dim: true },
					);
					return;
				}
				this.applyPermissionMode(argument.trim().toLowerCase());
				return;
			case "/copy":
				this.copyLastAssistant();
				return;
			case "/debug":
				this.writeDebugLog();
				return;
			case "/session":
				this.showSessionInfo();
				return;
			case "/login":
				this.addNotice(
					`Authenticate in a separate terminal:\n\n  io auth login opencode-go\n  io auth login openai-codex\n\nOr export OPENCODE_API_KEY. OpenAI-compatible providers are configured in ${this.options.paths.modelsPath}. Then restart io if the model list changes.`,
					{ dim: true },
				);
				return;
			case "/logout":
				this.addNotice("Remove credentials with `io auth logout [provider]` in a separate terminal.", {
					dim: true,
				});
				return;
			default:
				this.addNotice(`unknown command: ${command}. Type /help for commands.`, { bold: true });
		}
	}

	private applyVerbosity(
		level: Verbosity,
		options: { persist?: boolean; announce?: boolean } = {},
	): void {
		this.verbosity = level;
		this.thinkingVisible = level === "high";
		for (const block of this.assistantBlocks) block.setThinkingVisible(this.thinkingVisible);
		this.toolOutputExpanded = level === "high";
		for (const { block, entry, pinned } of this.toolEntries) {
			block.setExpanded(this.toolOutputExpanded);
			entry.setVisible(level !== "low" || pinned);
		}
		if (options.persist !== false) {
			this.config = { ...this.config, verbosity: level };
			try {
				saveConfig(this.options.paths, this.config);
			} catch (error) {
				this.addNotice(`could not save verbosity: ${(error as Error).message}`, { bold: true });
			}
		}
		if (options.announce !== false) {
			const detail =
				level === "low"
					? "tool output hidden"
					: level === "high"
						? "thinking visible, tools expanded"
						: "tools collapsed, thinking hidden";
			this.addNotice(`verbosity: ${level} — ${detail}`, { dim: true });
		}
		this.updateFooterAndTitle();
	}

	private applyPermissionMode(mode: string): void {
		if (!(PERMISSION_MODES as readonly string[]).includes(mode)) {
			this.addNotice("usage: /mode [ask|auto]", { bold: true });
			return;
		}
		const next = mode as PermissionMode;
		this.permissionMode = next;
		this.options.harness.setPermissionMode(next);
		this.config = { ...this.config, permissionMode: next };
		try {
			saveConfig(this.options.paths, this.config);
		} catch (error) {
			this.addNotice(`could not save permission mode: ${(error as Error).message}`, { bold: true });
		}
		this.addNotice(
			next === "auto"
				? "permission mode: auto — destructive shell commands run without confirmation. Built-in deny rules still apply. Use /mode ask to restore."
				: "permission mode: ask — destructive shell commands need your approval.",
			{ bold: next === "auto" },
		);
		this.updateFooterAndTitle();
	}

	private async showEffortSelector(): Promise<void> {
		if (this.activeOverlay) return;
		if (this.busy || this.session.isStreaming) {
			this.addNotice("Wait for the current response to finish before changing effort.", { dim: true });
			return;
		}
		const levels = this.session.getAvailableThinkingLevels();
		if (levels.length === 0) {
			this.addNotice("This model does not expose thinking levels.", { dim: true });
			return;
		}
		const current = this.session.thinkingLevel;
		const picker = new ThinkingSelectorComponent(
			current as never,
			levels as never[],
			(level) => {
				this.status = undefined;
				this.closeOverlay();
				void this.applyEffort(level);
				this.updateFooterAndTitle();
			},
			() => {
				this.status = undefined;
				this.closeOverlay();
				this.updateFooterAndTitle();
			},
		);

		this.activeOverlay = this.tui.showOverlay(picker, {
			anchor: "center",
			width: this.tui.terminal.columns,
			maxHeight: "70%",
			margin: 0,
		});
		this.tui.setFocus(picker);
		this.tui.requestRender();
	}

	private async applyEffort(levelRaw: string): Promise<void> {
		const levels = this.session.getAvailableThinkingLevels();
		const level = levels.find((entry) => entry.toLowerCase() === levelRaw.trim().toLowerCase());
		if (!level) {
			this.addNotice(`unknown effort "${levelRaw}". Available: ${levels.join(", ")}`, { bold: true });
			return;
		}
		try {
			this.session.setThinkingLevel(level, { persist: false });
			const actual = this.session.thinkingLevel ?? level;
			this.config = { ...this.config, thinkingLevel: actual };
			try {
				saveConfig(this.options.paths, this.config);
			} catch (error) {
				this.addNotice(`warning: effort changed but preference was not saved: ${(error as Error).message}`, {
					bold: true,
				});
			}
			this.addNotice(`effort: ${actual}`, { dim: true });
			this.updateFooterAndTitle();
		} catch (error) {
			this.addNotice(`could not set effort: ${(error as Error).message}`, { bold: true });
		}
	}

	private async compactSession(): Promise<void> {
		if (this.busy || this.session.isStreaming) {
			this.addNotice("Wait for the current response to finish before compacting.", { dim: true });
			return;
		}
		this.status = "compacting";
		this.updateFooterAndTitle();
		try {
			await this.session.compact();
			this.addNotice("context compacted", { dim: true });
		} catch (error) {
			this.addNotice(`could not compact: ${(error as Error).message}`, { bold: true });
		} finally {
			this.status = undefined;
			this.updateFooterAndTitle();
		}
	}

	private updateAgentAutocomplete(): void {
		const currentAgent = this.options.harness.agent;
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				[
					{ name: "help", description: "Show commands and keys" },
					{ name: "model", description: "Select or set a model", argumentHint: "[provider/model]" },
					{ name: "models", description: "List authenticated models" },
					{ name: "scope", description: "Select models Ctrl+P cycles through" },
					{ name: "effort", description: "Select or set thinking effort", argumentHint: "[level]" },
					{ name: "verbosity", description: "Set transcript detail", argumentHint: "[low|normal|high]" },
					{ name: "mode", description: "Set shell approval mode", argumentHint: "[ask|auto]" },
					{ name: "permissions", description: "Alias for /mode", argumentHint: "[ask|auto]" },
					{ name: "thinking", description: "Alias for /effort", argumentHint: "[level]" },
					{ name: "compact", description: "Compact the session context" },
					{ name: "new", description: "Start a new session" },
					{ name: "resume", description: "Open another session" },
					{ name: "name", description: "Rename the current session", argumentHint: "[name]" },
					{ name: "export", description: "Export the session", argumentHint: "[jsonl|html] [path]" },
					{ name: "fork", description: "Fork the session from a previous message", argumentHint: "[message]" },
					{ name: "agent", description: `Show current agent (current: ${currentAgent.id})`, argumentHint: "" },
					{ name: "diff", description: "Show git changes", argumentHint: "[path]" },
					{ name: "copy", description: "Copy the last assistant response" },
					{ name: "debug", description: "Write diagnostics to a log file" },
					{ name: "reload", description: "Reload config, session resources, and model catalogs" },
					{ name: "update", description: "Install the latest io release with Homebrew" },
					{ name: "editor", description: "Compose the prompt in $EDITOR" },
					{ name: "session", description: "Show session details" },
					{ name: "login", description: "Authentication instructions" },
					{ name: "logout", description: "Credential removal instructions" },
					{ name: "quit", description: "Exit io" },
					{ name: "exit", description: "Exit io" },
					{ name: "q", description: "Exit io" },
				],
				this.options.cwd,
				null,
			),
		);
	}

	private async switchToHarness(replacement: { harness: Harness; model?: Model<any>; thinkingLevel?: ThinkingLevel }): Promise<void> {
		const old = this.session;
		this.session = replacement.harness.session;
		this.options = { ...this.options, harness: replacement.harness };
		this.footer.setSession(this.session);
		this.subscribe();
		this.updateAgentAutocomplete();
		this.permissionMode = this.options.harness.getPermissionMode();
		this.transcript.clear();
		this.toolEntries = [];
		this.transcriptPruneNoticeShown = false;
		this.activeTools.clear();
		this.activeAssistant = undefined;
		this.lastUsage = undefined;
		this.lastDurationMs = undefined;
		this.statsCache = undefined;
		this.statsAt = 0;
		this.busy = false;
		this.status = undefined;
		this.programDone = false;
		this.programError = undefined;
		this.awaitingConfirm = false;
		this.assistantBlocks = [];
		this.lastAssistantText = "";
		this.queued = 0;
		this.renderInitialState();
		old.dispose();
		this.updateFooterAndTitle();
		this.addNotice("switched session", { dim: true });
	}

	private async newSession(): Promise<void> {
		if (this.busy || this.session.isStreaming) {
			this.addNotice("Wait for the current response to finish before starting a new session.", { dim: true });
			return;
		}
		this.status = "starting new session";
		this.updateFooterAndTitle();
		try {
			const replacement = await replaceHarnessSession(this.options.harness, {
				cwd: this.options.cwd,
				paths: this.options.paths,
				modelRuntime: this.options.runtime,
				confirmCommand: this.options.harness ? this.getConfirmCommand() : undefined,
				model: this.session.model ?? undefined,
				thinkingLevel: this.session.thinkingLevel ?? undefined,
			});
			await this.switchToHarness(replacement);
		} catch (error) {
			this.addNotice(`could not start a new session: ${(error as Error).message}`, { bold: true });
		} finally {
			this.status = undefined;
			this.updateFooterAndTitle();
		}
	}

	private async resumeSession(): Promise<void> {
		if (this.busy || this.session.isStreaming) {
			this.addNotice("Wait for the current response to finish before switching sessions.", { dim: true });
			return;
		}
		this.status = "loading sessions";
		this.updateFooterAndTitle();
		try {
			const { listSessions } = await import("../session.js");
			const sessions = await listSessions(this.options.paths, this.options.cwd);
			if (sessions.length === 0) {
				this.addNotice("No sessions for this directory.", { dim: true });
				return;
			}
			if (sessions.length === 1) {
				const selected = sessions[0];
				if (!selected) return;
				const replacement = await replaceHarnessSession(this.options.harness, {
					cwd: this.options.cwd,
					paths: this.options.paths,
					modelRuntime: this.options.runtime,
					confirmCommand: this.getConfirmCommand(),
					model: this.session.model ?? undefined,
					thinkingLevel: this.session.thinkingLevel ?? undefined,
					sessionId: selected.id,
				});
				await this.switchToHarness(replacement);
				return;
			}
			const items = sessions.slice(0, 40).map((session) => ({
				id: session.id,
				label: `${session.id.slice(0, 12)} · ${session.modified.toISOString().slice(0, 10)}`,
				description: `${session.messageCount} msgs · ${oneLine(session.firstMessage || session.name || "(no messages)", 48)}`,
			}));
			const picker = new SessionPicker(items, {
				maxVisible: Math.min(12, items.length),
				onSelect: async (item) => {
					this.closeOverlay();
					const selected = sessions.find((session) => session.id === item.id);
					if (!selected) return;
					const replacement = await replaceHarnessSession(this.options.harness, {
						cwd: this.options.cwd,
						paths: this.options.paths,
						modelRuntime: this.options.runtime,
						confirmCommand: this.getConfirmCommand(),
						model: this.session.model ?? undefined,
						thinkingLevel: this.session.thinkingLevel ?? undefined,
						sessionId: selected.id,
					});
					await this.switchToHarness(replacement);
				},
				onCancel: () => {
					this.status = undefined;
					this.closeOverlay();
					this.updateFooterAndTitle();
				},
			});
			this.activeOverlay = this.tui.showOverlay(new PaddedBox(picker), {
				anchor: "center",
				width: this.tui.terminal.columns,
				maxHeight: "70%",
				margin: 0,
			});
			this.tui.setFocus(picker);
			this.tui.requestRender();
		} catch (error) {
			this.addNotice(`could not load sessions: ${(error as Error).message}`, { bold: true });
		} finally {
			if (!this.activeOverlay) {
				this.status = undefined;
				this.updateFooterAndTitle();
			}
		}
	}

	private setSessionName(name: string): void {
		try {
			this.session.setSessionName(name);
			this.addNotice(`session name: ${name}`, { dim: true });
		} catch (error) {
			this.addNotice(`could not rename session: ${(error as Error).message}`, { bold: true });
		}
	}

	private async exportSession(argument?: string): Promise<void> {
		const match = argument?.trim().match(/^(\S+)(?:\s+(\S+))?/);
		const format = (match?.[1] || "html").toLowerCase();
		const outputPath = match?.[2];
		try {
			if (format === "jsonl" || format === "json") {
				const file = this.session.exportToJsonl(outputPath);
				this.addNotice(`exported session: ${file}`, { dim: true });
			} else if (format === "html") {
				const file = await this.session.exportToHtml(outputPath);
				this.addNotice(`exported session: ${file}`, { dim: true });
			} else {
				this.addNotice("usage: /export [jsonl|html] [path]", { dim: true });
			}
		} catch (error) {
			this.addNotice(`could not export session: ${(error as Error).message}`, { bold: true });
		}
	}

	private async forkSession(): Promise<void> {
		if (this.busy || this.session.isStreaming) {
			this.addNotice("Wait for the current response to finish before forking.", { dim: true });
			return;
		}
		const messages = this.session.getUserMessagesForForking();
		if (messages.length === 0) {
			this.addNotice("No user messages to fork from.", { dim: true });
			return;
		}
		if (messages.length === 1) {
			await this.doFork(messages[0]!);
			return;
		}
		this.status = "selecting fork point";
		this.updateFooterAndTitle();
		const items = messages.slice(-20).map((entry, index) => ({
			value: entry.entryId,
			label: `${index + 1}. ${oneLine(entry.text, 55)}`,
			description: "",
		}));
		const list = new SelectList(items, Math.min(14, items.length), selectListTheme);
		const box = new Container();
		box.addChild(new DynamicBorder());
		box.addChild(new Text(style.bold("Select a message to fork from"), 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(list);
		box.addChild(new Spacer(1));
		box.addChild(new Text(style.dim("↑↓ move · enter select · esc cancel"), 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(new DynamicBorder());
		list.onSelect = async (item) => {
			this.closeOverlay();
			const entry = messages.find((message) => message.entryId === item.value);
			if (entry) await this.doFork(entry);
		};
		list.onCancel = () => {
			this.status = undefined;
			this.closeOverlay();
			this.updateFooterAndTitle();
		};
		this.activeOverlay = this.tui.showOverlay(new PaddedBox(box), {
			anchor: "center",
			width: this.tui.terminal.columns,
			maxHeight: "70%",
			margin: 0,
		});
		this.tui.setFocus(list);
		this.tui.requestRender();
	}

	private async doFork(entry: { entryId: string; text: string }): Promise<void> {
		this.status = "forking";
		this.updateFooterAndTitle();
		try {
			const { SessionManager } = await import("@earendil-works/pi-coding-agent");
			const sessionFile = this.session.sessionFile;
			if (!sessionFile) {
				this.addNotice("Session is not persisted yet; cannot fork.", { dim: true });
				return;
			}
			const newManager = SessionManager.forkFrom(
				sessionFile,
				this.options.cwd,
				this.options.paths.sessionsDir,
			);
			const replacement = await replaceHarnessSession(this.options.harness, {
				cwd: this.options.cwd,
				paths: this.options.paths,
				modelRuntime: this.options.runtime,
				confirmCommand: this.getConfirmCommand(),
				model: this.session.model ?? undefined,
				thinkingLevel: this.session.thinkingLevel ?? undefined,
				sessionId: newManager.getSessionId(),
			});
			await this.switchToHarness(replacement);
			this.editor.setText(entry.text);
			this.addNotice(`forked from message · ${oneLine(entry.text, 60)}`, { dim: true });
		} catch (error) {
			this.addNotice(`could not fork: ${(error as Error).message}`, { bold: true });
		} finally {
			this.status = undefined;
			this.updateFooterAndTitle();
		}
	}

	private loadModels(): Promise<AvailableModels> {
		return this.options.availableModels?.() ?? loadAvailableModels(this.options.runtime);
	}

	private async showModelPicker(): Promise<void> {
		if (this.activeOverlay) return;
		if (this.busy || this.session.isStreaming) {
			this.addNotice("Wait for the current response to finish before changing models.", { dim: true });
			return;
		}
		this.status = "loading models";
		this.updateFooterAndTitle();
		try {
			const available = await this.loadModels();
			if (available.models.length === 0) {
				this.addNotice("No authenticated models. Run `io auth login` and try again.", { bold: true });
				return;
			}
			const current = (this.session.model ?? this.options.model) as Model<any> | undefined;
			const scopedRefs = this.config.scopedModels ?? [];
			const scoped = scopedRefs.length > 0
				? available.models.filter((model) => scopedRefs.includes(modelReference(model)))
				: available.models;
			const picker = new ModelSelectorComponent(
				this.tui,
				current,
				this.options.runtime,
				(scoped.length > 0 ? scoped : available.models).map((model) => ({ model })),
				(model) => {
					this.status = undefined;
					this.closeOverlay();
					void this.applyModel(model);
					this.updateFooterAndTitle();
				},
				() => {
					this.status = undefined;
					this.closeOverlay();
					this.updateFooterAndTitle();
				},
			);
			this.overlayDispose = () => picker.dispose();
			this.activeOverlay = this.tui.showOverlay(picker, {
				anchor: "center",
				width: this.tui.terminal.columns,
				maxHeight: "85%",
				margin: 0,
			});
			this.tui.setFocus(picker);
			this.tui.requestRender();
		} catch (error) {
			this.addNotice(`could not load models: ${(error as Error).message}`, { bold: true });
		} finally {
			if (!this.activeOverlay) {
				this.status = undefined;
				this.updateFooterAndTitle();
			}
		}
	}

	private closeOverlay(): void {
		this.overlayDispose?.();
		this.overlayDispose = undefined;
		if (!this.activeOverlay) return;
		this.activeOverlay.hide();
		this.activeOverlay = undefined;
		this.tui.setFocus(this.editor);
		this.tui.requestRender();
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		if (this.busy || this.session.isStreaming) {
			this.addNotice("Wait for the current response to finish before changing models.", { dim: true });
			return;
		}
		this.status = "loading models";
		this.updateFooterAndTitle();
		try {
			const available = await this.loadModels();
			const allModels = available.models;
			if (allModels.length <= 1) {
				this.addNotice("Only one authenticated model available.", { dim: true });
				return;
			}
			const scoped = this.config.scopedModels ?? [];
			let models = scoped.length > 0
				? allModels.filter((model) => scoped.includes(modelReference(model)))
				: allModels;
			if (models.length === 0 && scoped.length > 0) {
				this.addNotice("scoped models unavailable; cycling all", { dim: true });
				models = allModels;
			}
			if (models.length <= 1) {
				this.addNotice("Only one authenticated model available.", { dim: true });
				return;
			}
			const current = this.session.model;
			const currentIndex = current ? models.findIndex((model) => model.provider === current.provider && model.id === current.id) : -1;
			const nextIndex = direction === "forward"
				? (currentIndex + 1) % models.length
				: (currentIndex - 1 + models.length) % models.length;
			const next = models[nextIndex];
			if (!next) return;
			await this.applyModel(next);
		} catch (error) {
			this.addNotice(`could not cycle model: ${(error as Error).message}`, { bold: true });
		} finally {
			this.status = undefined;
			this.updateFooterAndTitle();
		}
	}

	private async setModelByReference(reference: string): Promise<void> {
		const available = await this.loadModels();
		const models = available.models;
		const parsed = parseModelReference(reference);
		const exact = models.find(
			(candidate) =>
				candidate.id === parsed.model && (parsed.provider === undefined || candidate.provider === parsed.provider),
		);
		// Same fuzzy search as the picker, so `/model kimi` finds
		// `opencode-go/kimi-k3` instead of requiring the full reference.
		const model =
			exact ??
			fuzzyFilter(models, reference, (candidate) =>
				modelSearchText({ id: candidate.id, provider: candidate.provider, name: candidate.name }),
			)[0];
		if (!model) {
			this.addNotice(`model "${reference}" is not available. Run /models to list options.`, { bold: true });
			return;
		}
		await this.applyModel(model);
	}

	private async applyModel(model: Model<any>): Promise<void> {
		try {
			await this.session.setModel(model);
		} catch (error) {
			this.addNotice(`could not select model: ${(error as Error).message}`, { bold: true });
			return;
		}
		this.config = { ...this.config, provider: model.provider, model: model.id };
		try {
			saveConfig(this.options.paths, this.config);
		} catch (error) {
			this.addNotice(`warning: model changed but preference was not saved: ${(error as Error).message}`, {
				bold: true,
			});
		}
		this.addNotice(`model: ${modelReference(model)}`, { dim: true });
		this.updateFooterAndTitle();
	}

	private async showScopePicker(): Promise<void> {
		if (this.activeOverlay) return;
		if (this.busy || this.session.isStreaming) {
			this.addNotice("Wait for the current response to finish before changing the model scope.", {
				dim: true,
			});
			return;
		}
		this.status = "loading models";
		this.updateFooterAndTitle();
		try {
			const available = await this.loadModels();
			const models = available.models;
			if (models.length === 0) {
				this.addNotice("No authenticated models. Run `io auth login` and try again.", { bold: true });
				return;
			}
			const items = models.map((model) => ({
				id: model.id,
				provider: model.provider,
				name: model.name,
				contextWindow: model.contextWindow,
			}));
			const maxVisible = Math.max(5, Math.min(14, this.tui.terminal.rows - 8, items.length));
			const scoped = this.config.scopedModels ?? [];
			const picker = new ScopedModelsPicker(items, {
				maxVisible,
				enabled: scoped.length > 0 ? scoped : items.map((item) => `${item.provider}/${item.id}`),
				onApply: (refs) => {
					this.status = undefined;
					this.closeOverlay();
					this.config = {
						...this.config,
						scopedModels: refs.length === items.length || refs.length === 0 ? undefined : refs,
					};
					try {
						saveConfig(this.options.paths, this.config);
					} catch (error) {
						this.addNotice(`warning: scope changed but preference was not saved: ${(error as Error).message}`, {
							bold: true,
						});
					}
					this.addNotice(
						refs.length === 0 ? "scoped models cleared (Ctrl+P cycles all)" : `scoped models: ${refs.length} (Ctrl+P cycles these)`,
						{ dim: true },
					);
					this.updateFooterAndTitle();
				},
				onCancel: () => {
					this.status = undefined;
					this.closeOverlay();
					this.updateFooterAndTitle();
				},
			});

			this.activeOverlay = this.tui.showOverlay(new PaddedBox(picker), {
				anchor: "center",
				width: this.tui.terminal.columns,
				maxHeight: "80%",
				margin: 0,
			});
			this.tui.setFocus(picker);
			this.tui.requestRender();
		} catch (error) {
			this.addNotice(`could not load models: ${(error as Error).message}`, { bold: true });
		} finally {
			if (!this.activeOverlay) {
				this.status = undefined;
				this.updateFooterAndTitle();
			}
		}
	}

	private async listModels(): Promise<void> {
		this.status = "loading models";
		this.updateFooterAndTitle();
		try {
			const available = await this.loadModels();
			if (available.models.length === 0) {
				this.addNotice("No authenticated models. Run `io auth login`.", { bold: true });
				return;
			}
			const lines = available.models.map((model) => {
				const current = this.session.model;
				const marker = current && model.provider === current.provider && model.id === current.id ? "*" : " ";
				return `${marker} ${modelReference(model)} — ${model.name}`;
			});
			this.addNotice(lines.join("\n"), { dim: true });
		} catch (error) {
			this.addNotice(`could not list models: ${(error as Error).message}`, { bold: true });
		} finally {
			this.status = this.busy ? "generating" : undefined;
			this.updateFooterAndTitle();
		}
	}

	private async showDiff(path?: string): Promise<void> {
		this.status = "reading diff";
		this.updateFooterAndTitle();
		try {
			const result = await getGitDiff(this.options.cwd, path);
			this.addNotice(`${style.bold("diff")}\n\n${result.text}`);
		} catch (error) {
			this.addNotice(`could not read diff: ${(error as Error).message}`, { bold: true });
		} finally {
			this.status = this.busy ? "generating" : undefined;
			this.updateFooterAndTitle();
		}
	}

	private copyLastAssistant(): void {
		const text = this.lastAssistantText;
		if (text.length === 0) {
			this.addNotice("nothing to copy yet", { dim: true });
			return;
		}
		const clipboard = getNativeClipboard();
		if (clipboard?.setText) {
			void Promise.resolve()
				.then(() => clipboard.setText?.(text))
				.then(
					() => this.addNotice(`copied ${formatTokens(text.length)} chars`, { dim: true }),
					(error) => this.addNotice(`clipboard unavailable: ${(error as Error).message}`, { bold: true }),
				);
			return;
		}
		const sequence = `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
		const write = (this.tui.terminal as { write?: (data: string) => void }).write;
		if (typeof write === "function") {
			write.call(this.tui.terminal, sequence);
			this.addNotice(`copied ${formatTokens(text.length)} chars (OSC 52)`, { dim: true });
			return;
		}
		this.addNotice("clipboard unavailable", { bold: true });
	}

	private resolveExternalEditor(): string | undefined {
		const configured = process.env.EDITOR || process.env.VISUAL;
		if (configured?.trim()) return configured.trim();
		for (const candidate of ["micro", "nano", "vim"]) {
			if (this.editorAvailable(candidate)) return candidate;
		}
		return undefined;
	}

	private editorAvailable(name: string): boolean {
		try {
			const result = spawnSync("which", [name], { stdio: "ignore" });
			return result.status === 0;
		} catch {
			return false;
		}
	}

	private async openExternalEditor(): Promise<void> {
		if (this.busy || this.session.isStreaming) {
			this.addNotice("Wait for the current response to finish before opening the editor.", { dim: true });
			return;
		}
		if (this.activeOverlay) return;
		const command = this.resolveExternalEditor();
		if (!command) {
			this.addNotice("no editor found (install micro/nano/vim or set $EDITOR)", { bold: true });
			return;
		}
		const [binary, ...args] = command.split(/\s+/).filter(Boolean);
		if (!binary) {
			this.addNotice("no editor configured (set $EDITOR)", { bold: true });
			return;
		}
		const tempPath = join(tmpdir(), `io-editor-${process.pid}-${Date.now()}.md`);
		try {
			writeFileSync(tempPath, this.editor.getText(), { encoding: "utf8", mode: 0o600 });
		} catch (error) {
			this.addNotice(`could not write editor buffer: ${(error as Error).message}`, { bold: true });
			return;
		}
		if (this.spinnerTimer !== undefined) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = undefined;
			this.spinnerIndex = 0;
		}
		try {
			this.tui.stop();
		} catch {
			// Best effort; the editor still needs a clean terminal.
		}
		let code: number | null = null;
		try {
			code = await new Promise<number | null>((resolvePromise) => {
				const child = spawn(binary, [...args, tempPath], {
					cwd: this.options.cwd,
					stdio: "inherit",
				});
				child.once("error", () => resolvePromise(1));
				child.once("exit", (exitCode) => resolvePromise(exitCode ?? 1));
			});
		} finally {
			try {
				this.tui.start();
			} catch {
				// The editor output already landed; rendering resumes below.
			}
			this.tui.setFocus(this.editor);
			this.updateFooterAndTitle();
			this.tui.requestRender();
		}
		try {
			if (code !== 0) {
				this.addNotice(`editor exited (${code}). Buffer kept as-is.`, { dim: true });
				rmSync(tempPath, { force: true });
				return;
			}
			const updated = readFileSync(tempPath, "utf8");
			this.editor.setText(updated.replace(/\n+$/, "") || updated);
			this.addNotice("editor buffer updated from file", { dim: true });
			this.tui.requestRender();
		} catch {
			this.addNotice("editor buffer kept as-is", { dim: true });
		} finally {
			rmSync(tempPath, { force: true });
		}
	}

	private reloadResources(): Promise<void> {
		if (this.busy || this.session.isStreaming) {
			this.addNotice("Wait for the current response to finish before reloading.", { dim: true });
			return Promise.resolve();
		}
		this.status = "reloading";
		this.updateFooterAndTitle();
		return this.reloadResourcesInner();
	}

	private async reloadResourcesInner(): Promise<void> {
		try {
			const reloaded = loadConfig(this.options.paths);
			for (const warning of reloaded.warnings) {
				this.addNotice(`warning: ${warning}`, { dim: true });
			}
			if (reloaded.error) {
				// Keep the last known good configuration instead of failing open
				// with an empty permission set.
				this.addNotice("reload skipped: config could not be read; keeping the current settings", {
					bold: true,
				});
			} else {
				this.config = reloaded.config;
				this.options.harness.applyConfig(reloaded.config);
				this.permissionMode = this.options.harness.getPermissionMode();
				this.bell = reloaded.config.bell !== false;
			}
			this.applyVerbosity(this.config.verbosity ?? "normal", { persist: false, announce: false });
			await this.session.reload();
			this.updateAgentAutocomplete();
			await reloadModelsJson(this.options.runtime, this.options.paths.modelsPath);
			const refreshed = await refreshCatalogs(this.options.runtime, undefined, { force: true });
			if (refreshed.errors.size > 0) {
				const details = [...refreshed.errors.entries()]
					.map(([providerId, error]) => `${providerName(providerId)}: ${error.message}`)
					.join("; ");
				this.addNotice(`model catalog refresh incomplete (${details}); using cached catalogs.`, {
					bold: true,
				});
			}
			this.addNotice("reloaded — config re-read, catalogs refreshed, session resources rebuilt", {
				dim: true,
			});
		} catch (error) {
			this.addNotice(`could not reload: ${(error as Error).message}`, { bold: true });
		} finally {
			this.status = this.busy ? "generating" : undefined;
			this.updateFooterAndTitle();
		}
	}

	private async checkForUpdate(): Promise<void> {
		if (this.busy || this.session.isStreaming) {
			this.addNotice("Wait for the current response to finish before updating.", { dim: true });
			return;
		}
		this.status = "checking for updates";
		this.updateFooterAndTitle();
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 10_000);
			let latest;
			try {
				latest = await fetchLatestRelease(undefined, {
					signal: controller.signal,
					userAgent: `io/${VERSION}`,
				});
			} finally {
				clearTimeout(timeout);
			}
			if (!latest) {
				this.addNotice("could not check for updates (offline?)", { bold: true });
				return;
			}
			const changelog = latest.htmlUrl
				? ` Changelog: ${latest.htmlUrl}`
				: ` Changelog: https://github.com/${GITHUB_REPOSITORY}/releases/tag/${latest.tag}`;
			if (compareVersions(latest.version, VERSION) <= 0) {
				this.addNotice(`io ${VERSION} is up to date.`, { dim: true });
				return;
			}
			if (!isHomebrewManaged()) {
				this.addNotice(
					`io ${latest.version} is available (you're running ${VERSION}). This build is not Homebrew-managed, so update your checkout or run \`brew upgrade io\`.${changelog}`,
					{ bold: true },
				);
				return;
			}
			this.addNotice(`updating io ${VERSION} → ${latest.version} with Homebrew…`, { bold: true });
			const ok = await this.runInlineShell("!!brew update && brew upgrade io", {
				status: "updating io",
				pinned: true,
			});
			if (!ok) {
				this.addNotice("update command failed; see the output above.", { bold: true });
				return;
			}
			const installed = this.readBrewInstalledVersion();
			if (installed === undefined) {
				this.addNotice(
					`Homebrew finished. Restart io to use ${latest.version}; could not verify the installed version.${changelog}`,
					{ bold: true },
				);
			} else if (compareVersions(installed, latest.version) >= 0) {
				this.addNotice(`io ${installed} installed. Restart io to use the new version.${changelog}`, {
					bold: true,
				});
			} else {
				this.addNotice(
					`Homebrew finished but the installed version is ${installed} (expected ${latest.version}). Run \`brew upgrade io\` to retry.${changelog}`,
					{ bold: true },
				);
			}
		} catch (error) {
			this.addNotice(`could not update: ${(error as Error).message}`, { bold: true });
		} finally {
			this.status = this.busy ? "generating" : undefined;
			this.updateFooterAndTitle();
		}
	}

	private readBrewInstalledVersion(): string | undefined {
		try {
			const brew = process.env.HOMEBREW_PREFIX
				? join(process.env.HOMEBREW_PREFIX, "bin", "brew")
				: "brew";
			const result = spawnSync(brew, ["list", "--versions", "io"], {
				encoding: "utf8",
				timeout: 15_000,
			});
			if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
			const fields = result.stdout.trim().split(/\s+/).filter(Boolean);
			return fields.at(-1);
		} catch {
			return undefined;
		}
	}

	private writeDebugLog(): void {
		try {
			const columns = this.tui.terminal.columns;
			const rendered: string[] = [];
			for (const child of this.transcript.children) {
				rendered.push(stripTerminalSequences(child.render(columns).join("\n")));
			}
			rendered.push("---");
			rendered.push(stripTerminalSequences(this.footer.render(columns).join("\n")));
			const messages = this.session.messages.slice(-20).map((message) => {
				const text = messageText(message as { content?: unknown }).replace(/\s+/g, " ").trim();
				return `${message.role}: ${text.slice(0, 200) || "(empty)"}`;
			});
			const lines = [
				`io debug — ${new Date().toISOString()}`,
				`cwd: ${this.options.cwd}`,
				`model: ${this.session.model ? modelReference(this.session.model as Model<any>) : "—"}`,
				`busy: ${this.busy} streaming: ${this.session.isStreaming}`,
				"",
				"--- rendered transcript ---",
				...rendered,
				"",
				`--- last ${messages.length} messages ---`,
				...messages,
			];
			ensureIoDirectories(this.options.paths);
			const logPath = join(this.options.paths.dataDir, "io-debug.log");
			writeFileSync(logPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
			this.addNotice(`debug log: ${logPath}`, { dim: true });
		} catch (error) {
			this.addNotice(`could not write debug log: ${(error as Error).message}`, { bold: true });
		}
	}

	private showSessionInfo(): void {
		const stats = this.session.getSessionStats();
		const model = this.session.model ?? this.options.model;
		const usage = this.lastUsage;
		const lines = [
			`session    ${stats.sessionId}`,
			`file       ${stats.sessionFile ?? "(not persisted)"}`,
			`cwd        ${this.options.cwd}`,
			`model      ${model ? modelReference(model as Model<any>) : "—"}`,
			`thinking   ${this.session.thinkingLevel ?? "—"}`,
			`verbosity  ${this.verbosity}`,
			`messages   ${formatCount(stats.totalMessages)} (${stats.userMessages} user, ${stats.assistantMessages} assistant, ${stats.toolResults} tool)`,
			`tokens     ${formatTokens(stats.tokens.input)} in · ${formatTokens(stats.tokens.output)} out · ${formatTokens(stats.tokens.cacheRead)} cache read`,
		];
		if (usage) {
			const speed = formatSpeed(usage.output, this.lastDurationMs);
			lines.push(`last       ${formatTokens(usage.input)} in · ${formatTokens(usage.output)} out${speed ? ` · ${speed}` : ""}`);
		}
		const context = stats.contextUsage;
		if (context && context.tokens !== null && context.percent !== null) {
			lines.push(
				`context    ${formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)} (${context.percent.toFixed(1)}%)`,
			);
		}
		if (stats.cost > 0) {
			lines.push(`cost       $${stats.cost.toFixed(4)}`);
		}
		this.addNotice(lines.join("\n"), { dim: true });
	}

	private async cancelGeneration(): Promise<void> {
		if (!this.session.isStreaming) {
			// A failed prompt can leave `busy` set without an active stream.
			// Clear it so Ctrl+C twice can exit instead of getting stuck.
			if (this.busy) {
				this.busy = false;
				this.status = undefined;
				this.updateFooterAndTitle();
			}
			return;
		}
		this.status = "cancelling";
		this.updateFooterAndTitle();
		try {
			await this.session.abort();
		} catch (error) {
			this.addNotice(`could not cancel: ${(error as Error).message}`, { bold: true });
		}
	}

	private confirmCommand: ConfirmCommand = async ({ command, reason, signal }) => {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			// An approval owns the only overlay slot. Close a stale picker first
			// instead of overwriting it and leaking its focus/dispose state.
			if (this.activeOverlay) this.closeOverlay();
			const short = oneLine(command, 90);
			// The overlay is the prompt; this notice is the record of it, so a
			// missed overlay still leaves a line saying what was asked and how it ended.
			const notice = new NoticeBlock(
				`${style.bold("approval needed")} ${short} ${style.dim(`(${reason})`)}`,
			);
			this.addBlock(notice);
			const finish = (allowed: boolean) => {
				if (settled) return;
				settled = true;
				this.awaitingConfirm = false;
				this.stopAwaitingTimer();
				signal?.removeEventListener("abort", onAbort);
				notice.setText(allowed ? style.dim(`✔ allowed ${short}`) : style.bold(`✖ denied ${short}`));
				this.status = this.busy ? "generating" : undefined;
				this.closeOverlay();
				this.updateFooterAndTitle();
				this.tui.requestRender();
				resolve(allowed);
			};
			const onAbort = () => finish(false);
			signal?.addEventListener("abort", onAbort, { once: true });
			const overlay = new ConfirmOverlay(
				command,
				reason,
				finish,
				() => {
					void this.cancelGeneration();
				},
				() => {
					// Update the in-memory permission state first so the next tool
					// call in this session is allowed, then persist the rule.
					try {
						const pattern = shellPatternFor(command);
						const added = this.options.harness.addPermissionRule({ resource: pattern, effect: "allow" });
						if (!added) {
							this.addNotice(`allow rule already active: ${pattern}`, { dim: true });
							return;
						}
						this.config = {
							...this.config,
							permissions: [...(this.config.permissions ?? []), { resource: pattern, effect: "allow" }],
						};
						saveConfig(this.options.paths, this.config);
						this.addNotice(`saved allow rule: ${pattern}`, { dim: true });
					} catch (error) {
						this.addNotice(`warning: could not save permission rule: ${(error as Error).message}`, {
							bold: true,
						});
					}
				},
			);
			this.awaitingConfirm = true;
			this.awaitingCommand = command;
			this.startAwaitingTimer();
			this.ringBell();
			this.activeOverlay = this.tui.showOverlay(new PaddedBox(overlay), {
				anchor: "center",
				width: this.tui.terminal.columns,
				maxHeight: "60%",
				margin: 0,
			});
			this.tui.setFocus(overlay);
			this.tui.requestRender();
			this.updateFooterAndTitle();
		});
	};

	getConfirmCommand(): ConfirmCommand {
		return this.confirmCommand;
	}

	/** Public shutdown hook for process signal handlers. */
	shutdown(code = 0): void {
		this.exit(code);
	}

	private exit(code: number): void {
		if (this.exiting) return;
		this.exiting = true;
		this.stopAwaitingTimer();
		if (this.activeOverlay) this.closeOverlay();
		if (this.statusLoader) {
			this.statusLoader.stop();
			this.statusLoader = undefined;
		}
		if (this.spinnerTimer !== undefined) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = undefined;
		}
		try {
			this.unsubscribe?.();
			this.session.dispose();
		} catch {
			// Terminal restoration is more important than a dispose error.
		}
		try {
			this.tui.terminal.setProgress(false);
		} catch {
			// Ignore; the process is exiting.
		}
		try {
			this.tui.terminal.setProgramStatus({ state: "clear", app: "io" });
		} catch {
			// Ignore; the process is exiting.
		}
		try {
			this.tui.stop();
		} catch {
			// Ignore; the process is exiting.
		}
		this.resolveExit?.(code);
	}
}
