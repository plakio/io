import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import {
	CombinedAutocompleteProvider,
	Container,
	Key,
	matchesKey,
	ProcessTerminal,
	SelectList,
	Spacer,
	Text,
	TuiMainScreen,
	type OverlayHandle,
} from "@earendil-works/pi-tui";
import type { SlashCommand } from "@earendil-works/pi-tui";
import type { AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { IoConfig, IoPaths, ThinkingLevel } from "../config.js";
import { saveConfig } from "../config.js";
import { formatContext, formatCount, formatSpeed, formatTokens, oneLine, shortSessionId } from "../format.js";
import { getGitDiff } from "../git-diff.js";
import { modelReference, parseModelReference } from "../providers.js";
import { loadAvailableModels } from "../runtime.js";
import {
	replaceHarnessSession,
	type ConfirmCommand,
	type Harness,
} from "../session.js";
import { getAgent, getPrimaryAgents, type AgentCatalog } from "../agents.js";
import { VERSION } from "../version.js";
import { AssistantBlock, ConfirmOverlay, Footer, NoticeBlock, PaddedBox, ToolBlock, UserBlock } from "./components.js";
import { IoEditor } from "./editor.js";
import { editorTheme, selectListTheme, style } from "./theme.js";

const HELP = `Commands

  /help            Show this help
  /model [ref]     Select a model, or set provider/model directly
  /models          List authenticated models
  /effort [level]  Select or set thinking effort
  /diff [path]     Show git status, stat, and patch
  /session         Show session details and token usage
  /login           Show authentication instructions
  /quit            Exit io

Keys

  Enter             Send prompt
  Shift+Enter       Insert newline (Ctrl+J also works)
  Esc or Ctrl+C     Cancel generation
  Ctrl+C twice      Exit when the prompt is empty
  Ctrl+O            Expand or collapse tool output`;

interface IoAppOptions {
	cwd: string;
	paths: IoPaths;
	runtime: ModelRuntime;
	harness: Harness;
	model: Model<any>;
	config: IoConfig;
	warnings?: string[];
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

export class IoApp {
	private options: IoAppOptions;
	private readonly tui: TuiMainScreen;
	private readonly header: Text;
	private readonly transcript: Container;
	private readonly editor: IoEditor;
	private readonly footer: Footer;
	private session: Harness["session"];
	private unsubscribe: (() => void) | undefined;
	private resolveExit: ((code: number) => void) | undefined;
	private exiting = false;
	private busy = false;
	private status: string | undefined;
	private queued = 0;
	private lastUsage: Usage | undefined;
	private lastDurationMs: number | undefined;
	private toolBlocks: ToolBlock[] = [];
	private activeTools = new Map<string, ToolBlock>();
	private activeAssistant: AssistantBlock | undefined;
	private activeOverlay: OverlayHandle | undefined;
	private toolOutputExpanded = false;
	private lastCtrlC = 0;
	private config: IoConfig;

	constructor(options: IoAppOptions) {
		this.options = options;
		this.session = options.harness.session;
		this.config = { ...options.config };
		this.tui = new TuiMainScreen(new ProcessTerminal());
		this.header = new Text(
			`${style.bold("io")}${style.dim(` ${VERSION}`)}\n${style.dim(options.cwd)}`,
			0,
			0,
		);
		this.transcript = new Container();
		this.editor = new IoEditor(this.tui, editorTheme);
		this.footer = new Footer();

		this.tui.addChild(this.header);
		this.tui.addChild(new Spacer(1));
		this.tui.addChild(this.transcript);
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
		this.tui.terminal.setTitle("io");
		this.updateFooter();
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
				if (block.getText().trim()) this.addBlock(block);
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
		this.addNotice("type /help for commands", { dim: true });
	}

	private addBlock(component: Text | UserBlock | AssistantBlock | ToolBlock, options: { spacing?: boolean } = {}): void {
		if (options.spacing !== false && this.transcript.children.length > 0) {
			this.transcript.addChild(new Spacer(1));
		}
		this.transcript.addChild(component);
		this.tui.requestRender();
	}

	private addNotice(text: string, options: { dim?: boolean; bold?: boolean } = {}): void {
		this.addBlock(new NoticeBlock(text, options));
	}

	private handleEvent(event: AgentSessionEvent): void {
		if (this.exiting) return;
		switch (event.type) {
			case "agent_start":
				this.busy = true;
				this.status = "generating";
				this.lastUsage = undefined;
				this.lastDurationMs = undefined;
				this.updateFooter();
				break;
			case "agent_end":
				if (!this.busy) this.busy = true;
				break;
			case "agent_settled":
				this.busy = false;
				this.status = undefined;
				this.activeAssistant?.dispose();
				this.activeAssistant = undefined;
				this.updateFooter();
				break;
			case "message_start":
				if (event.message.role === "user") {
					const text = messageText(event.message);
					if (text.trim()) this.addBlock(new UserBlock(text));
				} else if (event.message.role === "assistant") {
					const block = new AssistantBlock(() => this.tui.requestRender());
					block.setMessage(event.message, true);
					this.addBlock(block);
					this.activeAssistant = block;
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
					if (assistant.usage) {
						this.lastUsage = assistant.usage;
						this.lastDurationMs = assistant.durationMs;
					}
					this.updateFooter();
				}
				break;
			case "tool_execution_start": {
				const command =
					typeof event.args === "object" && event.args !== null && "command" in event.args
						? String((event.args as { command?: unknown }).command ?? "")
						: (JSON.stringify(event.args) ?? String(event.args));
				const block = new ToolBlock(event.toolName, command, () => this.tui.requestRender());
				this.toolBlocks.push(block);
				this.activeTools.set(event.toolCallId, block);
				this.status = `running ${event.toolName}`;
				this.addBlock(block);
				this.updateFooter();
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
				this.status = this.busy ? "generating" : undefined;
				this.updateFooter();
				break;
			}
			case "auto_retry_start":
				this.status = `retrying (${event.attempt}/${event.maxAttempts})`;
				this.addNotice(`provider error; retrying in ${Math.ceil(event.delayMs / 1000)}s (${event.attempt}/${event.maxAttempts})`, {
					dim: true,
				});
				this.updateFooter();
				break;
			case "auto_retry_end":
				if (!event.success) {
					this.addNotice(`retry failed: ${event.finalError ?? "unknown error"}`, { bold: true });
				}
				break;
			case "compaction_start":
				this.status = "compacting context";
				this.addNotice("compacting context…", { dim: true });
				this.updateFooter();
				break;
			case "compaction_end":
				this.status = this.busy ? "generating" : undefined;
				if (event.result) {
					this.addNotice("context compacted", { dim: true });
				} else if (event.errorMessage) {
					this.addNotice(`compaction failed: ${event.errorMessage}`, { bold: true });
				}
				this.updateFooter();
				break;
			case "queue_update":
				this.queued = event.steering.length + event.followUp.length;
				if (this.queued === 0 && this.busy && this.status === "queued") this.status = "generating";
				this.updateFooter();
				break;
			case "session_info_changed":
			case "thinking_level_changed":
			case "entry_appended":
				break;
			default:
				break;
		}
	}

	private updateFooter(): void {
		const model = this.session.model ?? this.options.model;
		const stats = this.session.getSessionStats();
		this.footer.setState({
			modelRef: model ? modelReference(model as Model<any>) : undefined,
			usage: this.lastUsage,
			speed: this.lastUsage ? formatSpeed(this.lastUsage.output, this.lastDurationMs) : undefined,
			context: formatContext(stats.contextUsage),
			sessionId: this.session.sessionId,
			busy: this.busy,
			status: this.status,
			queued: this.queued,
		});
		this.tui.requestRender();
	}

	private handleGlobalInput(data: string): { consume?: boolean } | undefined {
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.activeOverlay) return undefined;
			if (this.busy || this.session.isStreaming) {
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
				this.updateFooter();
				setTimeout(() => {
					if (!this.busy && this.status === "press ctrl+c again to exit") {
						this.status = undefined;
						this.updateFooter();
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
			if (this.busy) return undefined;
			void this.cycleModel("forward");
			return { consume: true };
		}

		if (matchesKey(data, Key.ctrlShift("p"))) {
			if (this.activeOverlay) return undefined;
			if (this.busy) return undefined;
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
			this.updateFooter();
			return { consume: true };
		}

		if (matchesKey(data, Key.ctrl("o"))) {
			if (this.activeOverlay) return undefined;
			this.toolOutputExpanded = !this.toolOutputExpanded;
			for (const block of this.toolBlocks) block.setExpanded(this.toolOutputExpanded);
			this.status = this.toolOutputExpanded ? "tool output expanded" : "tool output collapsed";
			this.updateFooter();
			setTimeout(() => {
				if (this.status === "tool output expanded" || this.status === "tool output collapsed") {
					this.status = this.busy ? "generating" : undefined;
					this.updateFooter();
				}
			}, 1500).unref?.();
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

	private async sendPrompt(text: string, options: { followUp?: boolean } = {}): Promise<void> {
		try {
			if (this.session.isStreaming) {
				if (!options.followUp) {
					this.status = "queued";
					this.updateFooter();
				}
				await this.session.prompt(text, { streamingBehavior: "followUp" });
			} else {
				await this.session.prompt(text);
			}
		} catch (error) {
			this.addNotice(`error: ${(error as Error).message}`, { bold: true });
			this.status = undefined;
			this.updateFooter();
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
		void this.sendPrompt(prompt);
	}

	private async handleCommand(input: string): Promise<void> {
		const space = input.indexOf(" ");
		const command = space === -1 ? input : input.slice(0, space);
		const argument = space === -1 ? "" : input.slice(space + 1).trim();
		switch (command) {
			case "/help":
				this.addNotice(HELP, { dim: true });
				return;
			case "/agent":
				if (!argument) {
					await this.showAgentSelector();
				} else {
					await this.applyAgent(argument);
				}
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
			case "/session":
				this.showSessionInfo();
				return;
			case "/login":
				this.addNotice(
					"Authenticate in a separate terminal:\n\n  io auth login opencode-go\n  io auth login openai-codex\n\nOr export OPENCODE_API_KEY. Then restart io if the model list changes.",
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

	private async showEffortSelector(): Promise<void> {
		if (this.activeOverlay) return;
		const levels = this.session.getAvailableThinkingLevels();
		if (levels.length === 0) {
			this.addNotice("This model does not expose thinking levels.", { dim: true });
			return;
		}
		const current = this.session.thinkingLevel;
		const items = levels.map((level) => ({
			value: level,
			label: level,
			description: level === current ? "current" : "",
		}));
		const list = new SelectList(items, Math.min(levels.length, 10), selectListTheme);
		if (current) {
			const index = levels.indexOf(current);
			if (index >= 0) list.setSelectedIndex(index);
		}
		const box = new Container();
		box.addChild(new Text(style.bold("Select thinking effort"), 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(list);
		box.addChild(new Spacer(1));
		box.addChild(new Text(style.dim("↑↓ move · enter select · esc cancel"), 0, 0));

		list.onSelect = (item) => {
			this.status = undefined;
			this.closeOverlay();
			void this.applyEffort(item.value);
			this.updateFooter();
		};
		list.onCancel = () => {
			this.status = undefined;
			this.closeOverlay();
			this.updateFooter();
		};

		this.activeOverlay = this.tui.showOverlay(new PaddedBox(box), {
			anchor: "center",
			width: this.tui.terminal.columns,
			maxHeight: "60%",
			margin: 0,
		});
		this.tui.setFocus(list);
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
			this.updateFooter();
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
		this.updateFooter();
		try {
			const result = await this.session.compact();
			this.addNotice("context compacted", { dim: true });
		} catch (error) {
			this.addNotice(`could not compact: ${(error as Error).message}`, { bold: true });
		} finally {
			this.status = undefined;
			this.updateFooter();
		}
	}

	private updateAgentAutocomplete(): void {
		const primaryAgents = getPrimaryAgents(this.options.harness.agentCatalog);
		const currentAgent = this.options.harness.agent;
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				[
					{ name: "help", description: "Show commands and keys" },
					{ name: "model", description: "Select or set a model", argumentHint: "[provider/model]" },
					{ name: "models", description: "List authenticated models" },
					{ name: "effort", description: "Select or set thinking effort", argumentHint: "[level]" },
					{ name: "compact", description: "Compact the session context" },
					{ name: "new", description: "Start a new session" },
					{ name: "resume", description: "Open another session" },
					{ name: "name", description: "Rename the current session", argumentHint: "[name]" },
					{ name: "export", description: "Export the session", argumentHint: "[jsonl|html] [path]" },
					{ name: "fork", description: "Fork the session from a previous message", argumentHint: "[message]" },
					{ name: "agent", description: `Switch primary agent (current: ${currentAgent.id})`, argumentHint: "[build|plan]" },
					...primaryAgents.map((agent) => ({
						name: agent.id,
						description: `${agent.name} agent (${agent.kind})`,
					})),
					{ name: "diff", description: "Show git changes", argumentHint: "[path]" },
					{ name: "session", description: "Show session details" },
					{ name: "login", description: "Authentication instructions" },
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
		this.subscribe();
		this.updateAgentAutocomplete();
		this.transcript.clear();
		this.toolBlocks = [];
		this.activeTools.clear();
		this.activeAssistant = undefined;
		this.lastUsage = undefined;
		this.lastDurationMs = undefined;
		this.busy = false;
		this.status = undefined;
		this.queued = 0;
		this.renderInitialState();
		old.dispose();
		this.updateFooter();
		this.addNotice("switched session", { dim: true });
	}

	private async newSession(): Promise<void> {
		if (this.busy || this.session.isStreaming) {
			this.addNotice("Wait for the current response to finish before starting a new session.", { dim: true });
			return;
		}
		this.status = "starting new session";
		this.updateFooter();
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
			this.updateFooter();
		}
	}

	private async resumeSession(): Promise<void> {
		if (this.busy || this.session.isStreaming) {
			this.addNotice("Wait for the current response to finish before switching sessions.", { dim: true });
			return;
		}
		this.status = "loading sessions";
		this.updateFooter();
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
			const items = sessions.slice(0, 20).map((session, index) => ({
				value: session.id,
				label: `${session.id.slice(0, 12)} · ${session.modified.toISOString().slice(0, 10)}`,
				description: `${session.messageCount} msgs · ${oneLine(session.firstMessage || session.name || "(no messages)", 40)}`,
			}));
			const list = new SelectList(items, Math.min(14, items.length), selectListTheme);
			const box = new Container();
			box.addChild(new Text(style.bold("Select a session"), 0, 0));
			box.addChild(new Spacer(1));
			box.addChild(list);
			box.addChild(new Spacer(1));
			box.addChild(new Text(style.dim("↑↓ move · enter select · esc cancel"), 0, 0));
			list.onSelect = async (item) => {
				this.closeOverlay();
				const selected = sessions.find((session) => session.id === item.value);
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
			};
			list.onCancel = () => {
				this.status = undefined;
				this.closeOverlay();
				this.updateFooter();
			};
			this.activeOverlay = this.tui.showOverlay(new PaddedBox(box), {
				anchor: "center",
				width: this.tui.terminal.columns,
				maxHeight: "70%",
				margin: 0,
			});
			this.tui.setFocus(list);
			this.tui.requestRender();
		} catch (error) {
			this.addNotice(`could not load sessions: ${(error as Error).message}`, { bold: true });
		} finally {
			if (!this.activeOverlay) {
				this.status = undefined;
				this.updateFooter();
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
		this.updateFooter();
		const items = messages.slice(-20).map((entry, index) => ({
			value: entry.entryId,
			label: `${index + 1}. ${oneLine(entry.text, 55)}`,
			description: "",
		}));
		const list = new SelectList(items, Math.min(14, items.length), selectListTheme);
		const box = new Container();
		box.addChild(new Text(style.bold("Select a message to fork from"), 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(list);
		box.addChild(new Spacer(1));
		box.addChild(new Text(style.dim("↑↓ move · enter select · esc cancel"), 0, 0));
		list.onSelect = async (item) => {
			this.closeOverlay();
			const entry = messages.find((message) => message.entryId === item.value);
			if (entry) await this.doFork(entry);
		};
		list.onCancel = () => {
			this.status = undefined;
			this.closeOverlay();
			this.updateFooter();
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
		this.updateFooter();
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
			this.updateFooter();
		}
	}

	private async showAgentSelector(): Promise<void> {
		if (this.activeOverlay) return;
		const primaryAgents = getPrimaryAgents(this.options.harness.agentCatalog);
		const current = this.options.harness.agent;
		const items = primaryAgents.map((agent) => ({
			value: agent.id,
			label: agent.name,
			description: agent.id === current.id ? "current" : agent.access,
		}));
		const list = new SelectList(items, Math.min(items.length, 10), selectListTheme);
		const box = new Container();
		box.addChild(new Text(style.bold("Select primary agent"), 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(list);
		box.addChild(new Spacer(1));
		box.addChild(new Text(style.dim("↑↓ move · enter select · esc cancel"), 0, 0));
		list.onSelect = async (item) => {
			this.closeOverlay();
			await this.applyAgent(item.value);
		};
		list.onCancel = () => {
			this.closeOverlay();
			this.updateFooter();
		};
		this.activeOverlay = this.tui.showOverlay(new PaddedBox(box), {
			anchor: "center",
			width: this.tui.terminal.columns,
			maxHeight: "60%",
			margin: 0,
		});
		this.tui.setFocus(list);
		this.tui.requestRender();
	}

	private async applyAgent(idRaw: string): Promise<void> {
		const id = idRaw.trim().toLowerCase();
		const agent = getAgent(this.options.harness.agentCatalog, id);
		if (!agent || agent.kind !== "primary") {
			this.addNotice(`unknown primary agent "${idRaw}". Available: ${getPrimaryAgents(this.options.harness.agentCatalog).map((agent) => agent.id).join(", ")}`, { bold: true });
			return;
		}
		if (agent.id === this.options.harness.agent.id) {
			this.addNotice(`agent: ${agent.id}`, { dim: true });
			return;
		}
		this.status = `switching to ${agent.id}`;
		this.updateFooter();
		try {
			const replacement = await replaceHarnessSession(this.options.harness, {
				cwd: this.options.cwd,
				paths: this.options.paths,
				modelRuntime: this.options.runtime,
				confirmCommand: this.getConfirmCommand(),
				model: this.session.model ?? undefined,
				thinkingLevel: this.session.thinkingLevel ?? undefined,
			});
			await this.switchToHarness(replacement);
			this.addNotice(`agent: ${agent.id} (${agent.name})`, { dim: true });
			this.updateFooter();
		} catch (error) {
			this.addNotice(`could not switch agent: ${(error as Error).message}`, { bold: true });
		} finally {
			this.status = undefined;
			this.updateFooter();
		}
	}

	private async showModelPicker(): Promise<void> {
		if (this.activeOverlay) return;
		this.status = "loading models";
		this.updateFooter();
		try {
			const available = await loadAvailableModels(this.options.runtime);
			const models = available.models;
			if (models.length === 0) {
				this.addNotice("No authenticated models. Run `io auth login` and try again.", { bold: true });
				return;
			}
			const current = this.session.model;
			const items = models.map((model) => ({
				value: modelReference(model),
				label: modelReference(model),
				description: `${model.name}${model.contextWindow ? ` · ${formatTokens(model.contextWindow)} ctx` : ""}`,
			}));
			const maxVisible = Math.max(5, Math.min(14, this.tui.terminal.rows - 8, items.length));
			const list = new SelectList(items, maxVisible, selectListTheme, {
				maxPrimaryColumnWidth: 44,
			});
			if (current) {
				const index = items.findIndex((item) => item.value === modelReference(current));
				if (index >= 0) list.setSelectedIndex(index);
			}
			const box = new Container();
			box.addChild(new Text(style.bold("Select a model"), 0, 0));
			box.addChild(new Spacer(1));
			box.addChild(list);
			box.addChild(new Spacer(1));
			box.addChild(new Text(style.dim("↑↓ move · enter select · esc cancel"), 0, 0));

			list.onSelect = (item) => {
				this.status = undefined;
				this.closeOverlay();
				const model = models.find((candidate) => modelReference(candidate) === item.value);
				if (model) void this.applyModel(model);
				this.updateFooter();
			};
			list.onCancel = () => {
				this.status = undefined;
				this.closeOverlay();
				this.updateFooter();
			};

			this.activeOverlay = this.tui.showOverlay(new PaddedBox(box), {
				anchor: "center",
				width: this.tui.terminal.columns,
				maxHeight: "80%",
				margin: 0,
			});
			this.tui.setFocus(list);
			this.tui.requestRender();
		} catch (error) {
			this.addNotice(`could not load models: ${(error as Error).message}`, { bold: true });
		} finally {
			if (!this.activeOverlay) {
				this.status = undefined;
				this.updateFooter();
			}
		}
	}

	private closeOverlay(): void {
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
		this.updateFooter();
		try {
			const available = await loadAvailableModels(this.options.runtime);
			const models = available.models;
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
			this.updateFooter();
		}
	}

	private async setModelByReference(reference: string): Promise<void> {
		const available = await loadAvailableModels(this.options.runtime);
		const models = available.models;
		const parsed = parseModelReference(reference);
		const model = models.find(
			(candidate) =>
				candidate.id === parsed.model && (parsed.provider === undefined || candidate.provider === parsed.provider),
		);
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
		this.updateFooter();
	}

	private async listModels(): Promise<void> {
		this.status = "loading models";
		this.updateFooter();
		try {
			const available = await loadAvailableModels(this.options.runtime);
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
			this.updateFooter();
		}
	}

	private async showDiff(path?: string): Promise<void> {
		this.status = "reading diff";
		this.updateFooter();
		try {
			const result = await getGitDiff(this.options.cwd, path);
			this.addNotice(`${style.bold("diff")}\n\n${result.text}`);
		} catch (error) {
			this.addNotice(`could not read diff: ${(error as Error).message}`, { bold: true });
		} finally {
			this.status = this.busy ? "generating" : undefined;
			this.updateFooter();
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
		if (!this.session.isStreaming) return;
		this.status = "cancelling";
		this.updateFooter();
		try {
			await this.session.abort();
		} catch (error) {
			this.addNotice(`could not cancel: ${(error as Error).message}`, { bold: true });
		}
	}

	private confirmCommand: ConfirmCommand = async ({ command, reason, signal }) => {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (allowed: boolean) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				this.closeOverlay();
				resolve(allowed);
			};
			const onAbort = () => finish(false);
			signal?.addEventListener("abort", onAbort, { once: true });
			const overlay = new ConfirmOverlay(command, reason, finish, () => {
				void this.cancelGeneration();
			});
			this.activeOverlay = this.tui.showOverlay(new PaddedBox(overlay), {
				anchor: "center",
				width: this.tui.terminal.columns,
				maxHeight: "60%",
				margin: 0,
			});
			this.tui.setFocus(overlay);
			this.tui.requestRender();
		});
	};

	getConfirmCommand(): ConfirmCommand {
		return this.confirmCommand;
	}

	private exit(code: number): void {
		if (this.exiting) return;
		this.exiting = true;
		try {
			this.unsubscribe?.();
			this.session.dispose();
		} catch {
			// Terminal restoration is more important than a dispose error.
		}
		try {
			this.tui.stop();
		} catch {
			// Ignore; the process is exiting.
		}
		this.resolveExit?.(code);
	}
}
