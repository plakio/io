import { statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getTreeSitterClient, type CliRenderer } from "@opentui/core";
import { getGitBranchAsync } from "../../git-diff.js";
import {
	ensureIoDirectories,
	loadConfig,
	saveConfig,
	type IoAppearanceConfig,
	type IoPaths,
	type IoThemePreference,
} from "../../config.js";import { formatCwdForFooter, formatTokens, shortSessionId } from "../../format.js";
import { OpenCodeEngine } from "../../engine/opencode.js";
import { syncModelsConfig } from "../../engine/models-config.js";
import { createIoSecurityPlugin, runShellCommand } from "../../engine/shell-plugin.js";
import type {
	AgentEngine,
	EngineAgent,
	EngineCommand,
	EngineModel,
	EngineModelRef,
	EnginePermissionRequest,
	EngineSession,
	EngineSessionSummary,
	IoEvent,
} from "../../engine/types.js";
import { VERSION } from "../../version.js";
import { loadKeybindings } from "../../keybindings.js";
import { IoAgentPicker, selectableAgents } from "./agent-picker.js";
import { IoAppearance } from "./appearance.js";
import { IoAutocomplete } from "./autocomplete.js";
import { IoCommandPalette } from "./command-palette.js";
import { createIoCommands } from "./commands.js";
import type { IoCommand } from "./keymap.js";
import { IoComposer, type IoCompletionItem } from "./composer.js";
import { IoConnectDialog } from "./connect-dialog.js";
import { IoDiffViewer } from "./diff-viewer.js";
import { editText } from "./editor.js";
import { IoFormSheet } from "./form-sheet.js";
import { IoErrorPanel } from "./error-panel.js";
import { IoImagePanel } from "./image-panel.js";
import { sessionMarkdown } from "./export.js";
import { IoKeymap } from "./keymap.js";
import { IoMcpPanel } from "./mcp-panel.js";
import { IoModelPicker } from "./model-picker.js";
import { IoPermissionSheet } from "./permission-sheet.js";
import { IoQueueManager } from "./queue-manager.js";
import { IoSessionSwitcher } from "./session-switcher.js";
import { IoSkillsPanel } from "./skills-panel.js";
import { IoSessionTabs } from "./session-tabs.js";
import { IoShell, type IoShellTodo } from "./shell.js";
import { IoSubagentPicker } from "./subagent-picker.js";
import { IoSettingsPanel, type IoSettingRow } from "./settings-panel.js";
import { IoStatusPanel } from "./status-panel.js";
import { IoTerminalPane } from "./terminal-pane.js";
import { IoThemePicker, type IoThemeOption } from "./theme-picker.js";
import { IoTimeline } from "./timeline.js";
import { IoTranscript } from "./transcript.js";
import { IoVariantPicker } from "./variant-picker.js";

export interface IoNextAppOptions {
	cwd: string;
	renderer: CliRenderer;
	engine: AgentEngine;
	paths?: IoPaths;
	remote?: boolean;
	appearance?: IoAppearanceConfig;
	sessionID?: string;
	model?: EngineModelRef;
	envNames?: readonly string[];
	onExit?: (code: number) => void;
}

const THEMES: readonly IoThemePreference[] = ["io", "io-light", "system", "dark", "light"];

const SLASH_COMMANDS: readonly IoCompletionItem[] = [
	{ value: "/help", description: "Show commands and keys", kind: "command" },
	{ value: "/resume", description: "Resume a previous session", kind: "command" },
	{ value: "/update", description: "Check for and install io updates", kind: "command" },
	{ value: "/connect", description: "Connect or remove providers", kind: "command" },
	{ value: "/agents", description: "List agents and subagents", kind: "command" },
	{ value: "/status", description: "Show session and engine status", kind: "command" },
	{ value: "/subagents", description: "Open a child session", kind: "command" },
	{ value: "/pin", description: "Pin or unpin the current session", kind: "command" },
	{ value: "/timeline", description: "Jump to a previous user message", kind: "command" },
	{ value: "/stash", description: "Stash, list or restore prompt drafts", kind: "command" },
	{ value: "/error", description: "Show the last error in full", kind: "command" },
	{ value: "/copy", description: "Copy the last message or session ID", kind: "command" },
	{ value: "/export", description: "Export the session to Markdown", kind: "command" },
	{ value: "/edit", description: "Edit the prompt in $EDITOR", kind: "command" },
	{ value: "/theme", description: "Preview and switch themes", kind: "command" },
	{ value: "/settings", description: "Change appearance settings", kind: "command" },
	{ value: "/clear", description: "Clear the transcript view", kind: "command" },
	{ value: "/mcp", description: "List MCP servers and reconnect", kind: "command" },
	{ value: "/skills", description: "List and activate skills", kind: "command" },
	{ value: "/usage", description: "Show model usage limits", kind: "command" },
	{ value: "/attach", description: "Attach a file to the next prompt", kind: "command" },
	{ value: "/attachments", description: "List prompt attachments", kind: "command" },
	{ value: "/detach", description: "Clear prompt attachments", kind: "command" },
	{ value: "/search", description: "Search messages in this session", kind: "command" },
	{ value: "/debug", description: "Show engine diagnostics", kind: "command" },
	{ value: "/permissions", description: "List or remove saved permission rules", kind: "command" },
	{ value: "/terminal", description: "Open the embedded terminal", kind: "command" },
	{ value: "/worktrees", description: "List git worktrees", kind: "command" },
	{ value: "/preview", description: "Preview an image attachment", kind: "command" },
	{ value: "/undo", description: "Revert the last user message", kind: "command" },
	{ value: "/redo", description: "Restore reverted messages", kind: "command" },
	{ value: "/agent", description: "Select the primary agent", kind: "command" },
	{ value: "/models", description: "List available models", kind: "command" },
	{ value: "/model", description: "Select a model", kind: "command" },
	{ value: "/new", description: "Start a new session", kind: "command" },
	{ value: "/continue", description: "Continue the latest session", kind: "command" },
	{ value: "/cd", description: "Change the working directory", kind: "command" },
	{ value: "/compact", description: "Compact the context", kind: "command" },
	{ value: "/diff", description: "Show git changes", kind: "command" },
	{ value: "/queue", description: "Manage queued prompts", kind: "command" },
	{ value: "/quit", description: "Exit io", kind: "command" },
	{ value: "/q", description: "Exit io", kind: "command" },
];

const HELP = `Commands
  /help          Show this help
  /resume        Resume a previous session
  /update        Check for and install io updates
  /connect       Connect or remove providers
  /agents        List agents and subagents
  /status        Show session and engine status
  /subagents     Open a child session
  /pin           Pin or unpin the current session
  /timeline      Jump to a previous user message
  /stash [list|pop|clear]  Stash or restore prompt drafts
  /error         Show the last error in full
  /copy [id]     Copy the last message or session ID
  /export [path] Export the session to Markdown
  /edit          Edit the prompt in $EDITOR
  /theme         Preview and switch themes
  /settings      Change appearance settings
  /clear         Clear the transcript view
  /mcp           List MCP servers and reconnect
  /skills        List and activate skills
  /usage         Show model usage limits
  /attach <path> Attach a file to the next prompt
  /attachments   List prompt attachments
  /detach        Clear prompt attachments
  /detach        Clear prompt attachments
  /search <text> Search messages in this session
  /debug         Show engine diagnostics
  /permissions [remove <id>]  List or remove saved permission rules
  /terminal      Open the embedded terminal
  /worktrees     List, create and switch git worktrees
  /preview [path] Preview an image attachment
  /undo          Revert the last user message
  /redo          Restore reverted messages
  /agent         Select the primary agent
  /models        List available models
  /model [ref]   Select a model, optionally by provider/id
  /new           Start a new session
  /continue      Continue the latest session
  /cd [path]     Show or change the working directory
  /compact       Compact the context
  /diff [path]   Show git changes, optionally filtered by path
  /queue         Manage queued prompts
  /quit, /q      Exit io

Keys
  Enter          Send the prompt or command
  Shift+Enter    Insert a new line
  Ctrl+J         Insert a new line
  Tab            Complete a command
  Ctrl+P         Command palette
  Ctrl+L         Clear screen
  Ctrl+O         Recent sessions
  Ctrl+F         Pin session
  Ctrl+X m       Models
  Ctrl+X a       Agents
  Ctrl+X l       Sessions
  Ctrl+X b       Toggle sidebar
  Ctrl+X g       Timeline
  Ctrl+X s       Status
  Ctrl+X d       Diff
  Ctrl+X q       Queue
  Ctrl+X e       Edit prompt in $EDITOR
  Ctrl+X j / k   Stash / restore draft
  Ctrl+X y       Copy last message
  Ctrl+X z       Last error
  Ctrl+X u / r   Undo / redo message
  Ctrl+X down    Subagents
  Ctrl+X up      Parent session
  Ctrl+1..9      Switch tab
  Ctrl+X o       Toggle tool output
  Ctrl+X t       Toggle thinking
  Ctrl+X v       Cycle verbosity
  Ctrl+X p       Toggle tokens per second
  Ctrl+X h       Switch theme
  Esc            Arm cancellation
  Esc twice      Interrupt a running turn`;

/** Wires the new OpenTUI shell to an AgentEngine. */
export class IoNextApp {
	private readonly options: IoNextAppOptions;
	private readonly appearance: IoAppearance;
	private readonly shell: IoShell;
	private readonly transcript: IoTranscript;
	private readonly composer: IoComposer;
	private readonly autocomplete: IoAutocomplete;
	private readonly tabs: IoSessionTabs;
	private readonly commands: readonly IoCommand[];
	private readonly keymap: IoKeymap;
	private session: EngineSession | undefined;
	private unsubscribe: (() => void) | undefined;
	private sessionList: readonly EngineSessionSummary[] = [];
	private agentList: readonly EngineAgent[] = [];
	private commandList: readonly EngineCommand[] = [];
	private palette: IoCommandPalette | undefined;
	private agentPicker: IoAgentPicker | undefined;
	private connectDialog: IoConnectDialog | undefined;
	private statusPanel: IoStatusPanel | undefined;
	private timeline: IoTimeline | undefined;
	private subagentPicker: IoSubagentPicker | undefined;
	private themePicker: IoThemePicker | undefined;
	private settingsPanel: IoSettingsPanel | undefined;
	private mcpPanel: IoMcpPanel | undefined;
	private skillsPanel: IoSkillsPanel | undefined;
	private terminalPane: IoTerminalPane | undefined;
	private imagePanel: IoImagePanel | undefined;
	private formSheet: IoFormSheet | undefined;
	private activeFormID: string | undefined;
	private updateAvailable: string | undefined;
	private modelPicker: IoModelPicker | undefined;
	private variantPicker: IoVariantPicker | undefined;
	private sessionSwitcher: IoSessionSwitcher | undefined;
	private diffViewer: IoDiffViewer | undefined;
	private queueManager: IoQueueManager | undefined;
	private permissionSheet: IoPermissionSheet | undefined;
	private pendingPermission: EnginePermissionRequest | undefined;
	private toolOutputExpanded = false;
	private todos: readonly IoShellTodo[] = [];
	private stashes: string[] = [];
	private attachments: string[] = [];
	private lastError: string | undefined;
	private errorPanel: IoErrorPanel | undefined;
	private readonly todoToolCalls = new Set<string>();
	private busy = false;
	private interruptArmed = false;
	private interruptTimer: NodeJS.Timeout | undefined;
	private spinTimer: NodeJS.Timeout | undefined;
	private spinFrame = 0;
	private turnStartedAt = 0;
	private readonly exitPromise: Promise<number>;
	private resolveExit!: (code: number) => void;
	private disposed = false;

	private constructor(options: IoNextAppOptions, engine: AgentEngine) {
		this.options = options;
		this.appearance = new IoAppearance(options.appearance);
		this.shell = new IoShell(options.renderer, {
			cwd: options.cwd,
			version: VERSION,
			theme: this.appearance.theme,
			showTps: this.appearance.tps,
			onTabSelect: (id) => void this.selectTab(Number(id)),
			onTabClose: (id) => void this.closeTab(Number(id)),
		});
		this.transcript = new IoTranscript({
			renderer: options.renderer,
			container: this.shell.transcriptContainer,
			theme: this.appearance.theme,
			showThinking: this.appearance.thinking,
		});
		this.appearance.applyToShell(this.shell);
		this.appearance.applyToTranscript(this.transcript);
		this.autocomplete = new IoAutocomplete({
			renderer: options.renderer,
			shell: this.shell,
			completions: SLASH_COMMANDS,
			cwd: () => this.options.cwd,
			agents: () => this.agentList.filter((agent) => !agent.hidden && agent.mode !== "primary"),
			onAccept: (text) => {
				this.composer.setText(text);
				this.shell.focusComposer();
			},
		});
		this.composer = new IoComposer({
			renderer: options.renderer,
			textarea: this.shell.composer,
			completions: SLASH_COMMANDS,
			onSubmit: (text, mode, delivery) => {
				void this.submit(text, mode, delivery);
			},
			onChange: (text) => this.autocomplete.update(text),
			onPasteSummary: (lines, characters) =>
				this.toast(`pasted ${lines} lines (${formatTokens(characters)} chars)`, "info"),
			onQueueChange: (queue) => this.shell.setFooter({ queue: queue.length }),
		});
		this.tabs = new IoSessionTabs(this.shell, engine);
		this.exitPromise = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
		this.commands = createIoCommands(
			this.commandHandlers(),
			options.paths ? loadKeybindings(options.paths) : {},
		);
		this.keymap = new IoKeymap({
			renderer: options.renderer,
			shell: this.shell,
			commands: this.commands,
			beforeKey: (event) => this.autocomplete.handleKey(event),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.transcript.addNotice("io 2.0 · OpenCode engine · OpenTUI", "info");
		this.transcript.addNotice("Ctrl+P commands · Ctrl+X leader · /help", "info");
	}

	static async create(options: IoNextAppOptions): Promise<IoNextApp> {
		const app = new IoNextApp(options, options.engine);
		await app.initialize(options.sessionID, options.model);
		return app;
	}

	async run(): Promise<number> {
		this.scheduleUpdateCheck();
		await this.refreshSessions();
		return this.exitPromise;
	}

	get currentSession(): EngineSession | undefined {
		return this.session;
	}

	async submit(text: string, mode: "prompt" | "shell" | "command", delivery: "steer" | "queue" = "steer"): Promise<void> {
		const prompt = text.trim();
		if (!prompt || !this.session) return;
		if (this.autocomplete.visible) {
			const command = this.autocomplete.isCommand;
			const match = this.autocomplete.accept();
			if (match) {
				if (command) {
					this.composer.clear();
					await this.runCommand(match.value);
				}
				return;
			}
		}
		if (mode === "command") {
			await this.runCommand(prompt);
			return;
		}
		if (mode === "shell") {
			await this.runInlineShell(prompt.replace(/^!/, "").trim());
			return;
		}
		this.transcript.addUser(prompt);
		try {
			if (this.session.revert) await this.session.commitRevert();
			const agents = this.mentionAgents(prompt);
			const files = this.attachments.map((file) => ({ uri: pathToFileURL(file).href, name: basename(file) }));
			await this.session.prompt(prompt, {
				delivery,
				wait: false,
				...(agents.length > 0 ? { agents } : {}),
				...(files.length > 0 ? { files } : {}),
			});
			if (files.length > 0) this.attachments = [];
		} catch (error) {
			this.lastError = String((error as Error).message ?? error);
			this.toast(this.lastError, "error");
		}
	}

	async shutdown(code = 0): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.stopWorking();
		this.disarmInterrupt();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		try {
			await this.session?.dispose();
		} catch {
			// Best effort.
		}
		this.palette?.dispose();
		this.agentPicker?.dispose();
		this.formSheet?.dispose();
		this.imagePanel?.dispose();
		this.terminalPane?.dispose();
		this.skillsPanel?.dispose();
		this.mcpPanel?.dispose();
		this.settingsPanel?.dispose();
		this.themePicker?.dispose();
		this.subagentPicker?.dispose();
		this.errorPanel?.dispose();
		this.timeline?.dispose();
		this.statusPanel?.dispose();
		this.connectDialog?.dispose();
		this.variantPicker?.dispose();
		this.modelPicker?.dispose();
		this.sessionSwitcher?.dispose();
		this.diffViewer?.dispose();
		this.queueManager?.dispose();
		this.permissionSheet?.dispose();
		this.keymap.dispose();
		this.autocomplete.dispose();
		this.composer.dispose();
		this.transcript.dispose();
		this.shell.dispose();
		try {
			await this.options.engine.close();
		} catch {
			// Best effort.
		}
		this.options.onExit?.(code);
		this.resolveExit(code);
	}

	private async initialize(sessionID?: string, model?: EngineModelRef): Promise<void> {
		// Markdown/Code renderables start highlighting on mount. Initialize the
		// Tree-sitter worker first, otherwise the first frame falls back to plain
		// text and the warning sticks for the rest of the session.
		await getTreeSitterClient()
			.initialize()
			.catch(() => undefined);
		const [models, agents, commands] = await Promise.all([
			this.options.engine.listModels(),
			this.options.engine.listAgents(),
			this.options.engine.listCommands().catch(() => []),
		]);
		this.agentList = agents;
		this.commandList = commands;
		this.autocomplete.setCompletions(this.allCompletions());
		const selected = model ?? (models[0] ? { provider: models[0].provider, id: models[0].id } : undefined);
		const session = sessionID
			? await this.options.engine.resumeSession(sessionID)
			: await this.options.engine.createSession({ directory: this.options.cwd, model: selected });
		await this.attachSession(session);
		await this.refreshSessions();
		await this.refreshFooter();
	}

	private async attachSession(session: EngineSession): Promise<void> {
		this.unsubscribe?.();
		if (this.session && this.session !== session) await this.session.dispose().catch(() => undefined);
		this.session = session;
		this.autocomplete.hide();
		this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
		this.shell.setHeader({ sessionID: shortSessionId(session.id) });
		this.transcript.clear();
		this.todoToolCalls.clear();
		this.shell.setTodos([]);
		this.transcript.addNotice(`session ${shortSessionId(session.id)}`, "info");
		const messages = await session.messages().catch(() => []);
		for (const message of messages) {
			if (message.role === "user") this.transcript.addUser(message.text);
			else if (message.role === "assistant") this.transcript.addAssistant(message.text);
		}
		await this.refreshFooter();
		void this.refreshSidebar();
	}

	private handleEvent(event: IoEvent): void {
		this.transcript.apply(event);
		if (event.type === "tool_started" && event.name === "todowrite") {
			this.todoToolCalls.add(event.toolCallID);
			return;
		}
		if (event.type === "tool_called" && this.todoToolCalls.has(event.toolCallID)) {
			const todos = parseTodos(event.input);
			if (todos) {
				this.todos = todos;
				this.shell.setTodos(todos);
				void this.refreshSidebar();
			}
			return;
		}
		if (event.type === "tool_finished") {
			this.todoToolCalls.delete(event.toolCallID);
		}
		if (event.type === "turn_started") {
			this.busy = true;
			this.disarmInterrupt();
			this.startWorking();
			return;
		}
		if (event.type === "turn_ended") {
			this.busy = false;
			this.stopWorking();
			this.disarmInterrupt();
			this.shell.setFooter({ mode: event.outcome === "succeeded" ? "ready" : event.outcome });
			if (process.env.IO_NOTIFY === "1") {
				this.options.renderer.triggerNotification(
					event.outcome === "succeeded" ? "turn complete" : `turn ${event.outcome}`,
					"io",
				);
			}
			if (event.outcome === "failed") {
				this.lastError = event.error ?? "turn failed";
				this.toast(this.lastError, "error");
			}
			void this.refreshFooter();
			void this.refreshSessions();
			void this.refreshSidebar();
			return;
		}
		if (event.type === "usage_updated") {
			this.shell.setFooter({
				tokens: `${formatTokens(event.tokens.input)} in · ${formatTokens(event.tokens.output)} out`,
				cost: event.cost > 0 ? `$${event.cost.toFixed(4)}` : undefined,
			});
			return;
		}
		if (event.type === "queue_changed") {
			this.shell.setFooter({ queue: event.pending });
			return;
		}
		if (event.type === "form_requested") {
			this.openForm(event.form);
			return;
		}
		if (event.type === "form_resolved") {
			if (this.activeFormID === event.formID) {
				this.activeFormID = undefined;
				this.formSheet?.close();
				this.formSheet = undefined;
			}
			return;
		}
		if (event.type === "permission_requested") {
			this.openPermission(event.request);
			return;
		}
		if (event.type === "retry_scheduled") {
			this.toast(`retrying in ${Math.max(1, Math.round(event.at / 1000))}s`, "warning");
			return;
		}
		if (event.type === "compaction_started") {
			this.toast("compacting context", "info");
			return;
		}
		if (event.type === "compaction_failed") {
			this.toast(`compaction failed: ${event.error}`, "error");
			return;
		}
		if (event.type === "error") {
			this.lastError = event.message;
			this.toast(event.message, "error");
		}
	}

	private openForm(form: import("../../engine/types.js").EngineForm): void {
		this.formSheet?.dispose();
		this.activeFormID = form.id;
		this.formSheet = new IoFormSheet({
			renderer: this.options.renderer,
			shell: this.shell,
			form,
			onReply: async (current, answer) => {
				try {
					await this.session?.replyForm(current.id, answer);
				} catch (error) {
					this.toast(String((error as Error).message ?? error), "error");
				}
			},
			onCancel: async (current, message) => {
				try {
					await this.session?.cancelForm(current.id, message);
				} catch (error) {
					this.toast(String((error as Error).message ?? error), "error");
				}
			},
			onClose: () => {
				if (this.activeFormID === form.id) this.activeFormID = undefined;
				this.resumeUi();
			},
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.suspendUi();
		this.formSheet.open();
	}

	private openPermission(request: EnginePermissionRequest): void {
		this.pendingPermission = request;
		this.closeTransientOverlays();
		this.permissionSheet ??= new IoPermissionSheet({
			renderer: this.options.renderer,
			shell: this.shell,
			onDecision: async (decision, message) => {
				const pending = this.pendingPermission;
				this.pendingPermission = undefined;
				if (pending && this.session) {
					await this.session.respondPermission(pending.requestID, decision, message);
				}
			},
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.suspendUi();
		this.permissionSheet.open(request);
	}

	private async runCommand(text: string): Promise<void> {
		const [command = "", ...args] = text.trim().split(/\s+/);
		switch (command) {
			case "/help":
				this.transcript.addNotice(HELP, "info");
				return;
			case "/model":
				if (args[0]) {
					await this.selectModel(args[0]);
					return;
				}
				await this.openModels();
				return;
			case "/models":
				await this.listModels();
				return;
			case "/agent":
				await this.openAgents();
				return;
			case "/agents":
				await this.listAgents();
				return;
			case "/status":
				await this.openStatus();
				return;
			case "/subagents":
				await this.openSubagents();
				return;
			case "/pin":
				this.togglePin();
				return;
			case "/timeline":
				this.openTimeline();
				return;
			case "/stash":
				this.stashCommand(args[0]);
				return;
			case "/error":
				this.openError();
				return;
			case "/undo":
				await this.undo();
				return;
			case "/redo":
				await this.redo();
				return;
			case "/copy":
				await this.copyCommand(args[0]);
				return;
			case "/export":
				await this.exportSession(args[0]);
				return;
			case "/edit":
				await this.openEditor();
				return;
			case "/theme":
				this.openThemes();
				return;
			case "/settings":
				this.openSettings();
				return;
			case "/clear":
				this.clearScreen();
				return;
			case "/mcp":
				await this.openMcp();
				return;
			case "/skills":
				await this.openSkills();
				return;
			case "/usage":
				await this.showUsage();
				return;
			case "/attach":
				this.attachFile(args.join(" "));
				return;
			case "/attachments":
				this.listAttachments();
				return;
			case "/detach":
				this.attachments = [];
				this.toast("attachments cleared", "info");
				return;
			case "/search":
				await this.searchMessages(args.join(" "));
				return;
			case "/debug":
				await this.showDebug();
				return;
			case "/permissions":
				await this.permissionsCommand(args);
				return;
			case "/terminal":
				this.openTerminal();
				return;
			case "/worktrees":
				await this.worktreesCommand(args);
				return;
			case "/preview":
				this.previewImage(args[0]);
				return;
			case "/sessions":
			case "/resume":
				await this.openSessions();
				return;
			case "/continue":
				await this.continueSession();
				return;
			case "/update":
				await this.update();
				return;
			case "/connect":
				await this.openConnect();
				return;
			case "/cd":
				await this.changeDirectory(args[0]);
				return;
			case "/new":
				await this.newSession();
				return;
			case "/compact":
				await this.compact();
				return;
			case "/diff":
				await this.openDiff(args[0]);
				return;
			case "/queue":
				this.openQueue();
				return;
			case "/quit":
			case "/q":
				await this.shutdown(0);
				return;
			default: {
				const custom = this.commandList.find((entry) => `/${entry.name}` === command);
				if (custom) {
					await this.runCustomCommand(custom, args.join(" "));
					return;
				}
				this.transcript.addNotice(`unknown command: ${command}. Type /help.`, "warning");
			}
		}
	}

	private async listModels(): Promise<void> {
		const models = await this.options.engine.listModels();
		if (models.length === 0) {
			this.transcript.addNotice("no models available. Run io auth login.", "warning");
			return;
		}
		const current = this.session?.model;
		const lines = models.map((model) => {
			const ref = `${model.provider}/${model.id}`;
			const active = current?.provider === model.provider && current.id === model.id ? "*" : " ";
			const variants = model.variants.length > 0 ? ` · variants: ${model.variants.join(", ")}` : "";
			return `${active} ${ref}${variants}`;
		});
		this.transcript.addNotice(`Models\n${lines.join("\n")}`, "info");
	}

	private async selectModel(ref: string): Promise<void> {
		const models = await this.options.engine.listModels();
		const model = models.find(
			(candidate) => `${candidate.provider}/${candidate.id}` === ref || candidate.id === ref,
		);
		if (!model) {
			this.transcript.addNotice(`unknown model: ${ref}. Type /models.`, "warning");
			return;
		}
		await this.session?.setModel({ provider: model.provider, id: model.id });
		await this.refreshFooter();
		this.toast(`model ${model.provider}/${model.id}`, "success");
	}

	private async listAgents(): Promise<void> {
		if (this.agentList.length === 0) this.agentList = await this.options.engine.listAgents();
		if (this.agentList.length === 0) {
			this.transcript.addNotice("no agents available", "warning");
			return;
		}
		const current = this.session?.agent;
		const lines = this.agentList.map((agent) => {
			const active = current === agent.id ? "*" : " ";
			const kind = agent.hidden ? "hidden" : agent.mode;
			return `${active} ${agent.name} (${agent.id}) · ${kind}${agent.description ? `\n  ${agent.description}` : ""}`;
		});
		this.transcript.addNotice(`Agents\n${lines.join("\n")}`, "info");
	}

	private async openAgents(): Promise<void> {
		if (this.agentList.length === 0) this.agentList = await this.options.engine.listAgents();
		const agents = selectableAgents(this.agentList);
		if (agents.length === 0) {
			this.toast("no primary agents available", "warning");
			return;
		}
		this.agentPicker?.dispose();
		this.agentPicker = new IoAgentPicker({
			renderer: this.options.renderer,
			shell: this.shell,
			agents: this.agentList,
			current: this.session?.agent,
			onSelect: (agent) => this.applyAgent(agent),
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.suspendUi();
		this.agentPicker.open();
	}

	private async applyAgent(agent: EngineAgent): Promise<void> {
		await this.session?.setAgent(agent.id);
		await this.refreshFooter();
		this.toast(`agent ${agent.name}`, "success");
	}	private async openStatus(): Promise<void> {
		this.formSheet?.dispose();
		this.imagePanel?.dispose();
		this.terminalPane?.dispose();
		this.skillsPanel?.dispose();
		this.mcpPanel?.dispose();
		this.settingsPanel?.dispose();
		this.themePicker?.dispose();
		this.subagentPicker?.dispose();
		this.errorPanel?.dispose();
		this.timeline?.dispose();
		this.statusPanel?.dispose();
		this.statusPanel = new IoStatusPanel({
			renderer: this.options.renderer,
			shell: this.shell,
			load: async () => {
				const session = this.session;
				const stats = await session?.stats().catch(() => undefined);
				const [branch, mcps] = await Promise.all([
					getGitBranchAsync(this.options.cwd),
					this.options.engine.listMcp().catch(() => []),
				]);
				const model = session?.model;
				const agents = this.agentList
					.filter((agent) => !agent.hidden && agent.mode !== "subagent")
					.map((agent) => agent.name)
					.join(", ");
				const context =
					stats?.contextPercent === null || stats?.contextPercent === undefined
						? "—"
						: `${stats.contextPercent.toFixed(1)}%`;
				return [
					`Version    io ${VERSION} · ${this.options.engine.kind}`,
					`Directory  ${this.options.cwd}`,
					`Branch     ${branch ?? "—"}`,
					`Session    ${session?.id ?? "—"}`,
					`Agent      ${this.agentName(session?.agent) ?? "—"}`,
					`Model      ${model ? `${model.provider}/${model.id}` : "—"}`,
					`Effort     ${model?.variant ?? "default"}`,
					`Context    ${context}`,
					`Tokens     ${stats ? `${formatTokens(stats.tokens.input)} in · ${formatTokens(stats.tokens.output)} out` : "—"}`,
					`Cost       ${stats && stats.cost > 0 ? `$${stats.cost.toFixed(4)}` : "—"}`,
					`Queue      ${this.composer.queued.length}`,
					`Agents     ${agents || "—"}`,
					`MCP        ${mcps.length === 0 ? "none" : mcps.map((server) => `${server.name}:${server.status}`).join(", ")}`,
					`Auth       /connect`,
					`View       ${this.appearance.themePreference} · ${this.appearance.verbosity} · thinking ${this.appearance.thinking ? "on" : "off"}`,
				];
			},
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.suspendUi();
		await this.statusPanel.open();
	}

	private openError(): void {
		if (!this.lastError) {
			this.toast("no error to show", "info");
			return;
		}
		this.errorPanel ??= new IoErrorPanel({
			renderer: this.options.renderer,
			shell: this.shell,
			onClose: () => this.resumeUi(),
		});
		this.suspendUi();
		this.errorPanel.open(this.lastError);
	}

	private stashCommand(action?: string): void {
		if (action === "list") {
			if (this.stashes.length === 0) {
				this.transcript.addNotice("no stashed drafts", "info");
				return;
			}
			this.transcript.addNotice(
				`Stashed drafts\n${this.stashes.map((draft, index) => `${index + 1}. ${draft.replace(/\s+/g, " ")}`).join("\n")}`,
				"info",
			);
			return;
		}
		if (action === "clear") {
			this.stashes = [];
			this.toast("stash cleared", "info");
			return;
		}
		if (action === "pop") {
			const draft = this.stashes.pop();
			if (!draft) {
				this.toast("no stashed drafts", "warning");
				return;
			}
			this.composer.setText(draft);
			this.shell.focusComposer();
			this.toast("draft restored", "success");
			return;
		}
		const draft = this.composer.text.trim();
		if (!draft) {
			this.toast("nothing to stash", "warning");
			return;
		}
		this.stashes.push(draft);
		this.composer.clear();
		this.toast("draft stashed", "success");
	}

	private async openSubagents(): Promise<void> {
		if (!this.session) return;
		const sessions = await this.options.engine.listSessions({
			directory: this.options.cwd,
			parentID: this.session.id,
			limit: 50,
		});
		if (sessions.length === 0) {
			this.toast("this session has no subagents", "info");
			return;
		}
		this.formSheet?.dispose();
		this.imagePanel?.dispose();
		this.terminalPane?.dispose();
		this.skillsPanel?.dispose();
		this.mcpPanel?.dispose();
		this.settingsPanel?.dispose();
		this.themePicker?.dispose();
		this.subagentPicker?.dispose();
		this.subagentPicker = new IoSubagentPicker({
			renderer: this.options.renderer,
			shell: this.shell,
			sessions,
			activeID: this.session.id,
			onSelect: (entry) => this.openSession(entry.id),
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.suspendUi();
		this.subagentPicker.open();
	}

	private async openParent(): Promise<void> {
		const parentID = this.session?.parentID;
		if (!parentID) {
			this.toast("already at the root session", "info");
			return;
		}
		await this.openSession(parentID);
	}

	private async cycleSibling(delta: number): Promise<void> {
		const current = this.session;
		if (!current) return;
		const siblings = await this.options.engine.listSessions({
			directory: this.options.cwd,
			parentID: current.parentID ?? null,
			limit: 50,
		});
		if (siblings.length < 2) return;
		const index = siblings.findIndex((entry) => entry.id === current.id);
		const next = siblings[(index + delta + siblings.length) % siblings.length];
		if (next && next.id !== current.id) await this.openSession(next.id);
	}

	private async openSession(sessionID: string): Promise<void> {
		const session = await this.options.engine.resumeSession(sessionID);
		await this.attachSession(session);
		await this.refreshSessions();
	}

	private async openEditor(): Promise<void> {
		this.autocomplete.hide();
		try {
			await this.options.renderer.suspend();
		} catch {
			// Some terminals cannot suspend; the editor still works inline.
		}
		try {
			const result = editText(this.composer.text, { cwd: this.options.cwd });
			if (result.saved) {
				this.composer.setText(result.text.trimEnd());
				this.shell.focusComposer();
			} else {
				this.toast("editor exited without saving", "warning");
			}
		} finally {
			try {
				await this.options.renderer.resume();
			} catch {
				// Resume is best effort on non-terminal renderers.
			}
			this.shell.focusComposer();
			this.options.renderer.requestRender();
		}
	}

	private copyText(text: string): boolean {
		try {
			return this.options.renderer.copyToClipboardOSC52(text);
		} catch {
			return false;
		}
	}

	private async copyCommand(what?: string): Promise<void> {
		const session = this.session;
		if (!session) return;
		if (what === "id") {
			const copied = this.copyText(session.id);
			this.toast(copied ? "session ID copied" : "clipboard unavailable", copied ? "success" : "warning");
			return;
		}
		const messages = await session.messages();
		const last = [...messages].reverse().find((message) => message.text.trim().length > 0);
		if (!last) {
			this.toast("nothing to copy", "info");
			return;
		}
		const copied = this.copyText(last.text);
		this.toast(copied ? "message copied" : "clipboard unavailable", copied ? "success" : "warning");
	}

	private async exportSession(path?: string): Promise<void> {
		const session = this.session;
		if (!session) return;
		const messages = await session.messages();
		const title = this.sessionList.find((entry) => entry.id === session.id)?.title;
		const model = session.model;
		const markdown = sessionMarkdown({
			id: session.id,
			title,
			agent: this.agentName(session.agent),
			model: model ? `${model.provider}/${model.id}${model.variant ? `#${model.variant}` : ""}` : undefined,
			messages,
		});
		const target = path
			? resolve(this.options.cwd, path)
			: join(this.options.cwd, `io-session-${shortSessionId(session.id)}.md`);
		try {
			writeFileSync(target, markdown);
			this.transcript.addNotice(`exported ${target}`, "success");
			this.toast("session exported", "success");
		} catch (error) {
			this.lastError = String((error as Error).message ?? error);
			this.toast(this.lastError, "error");
		}
	}

	private async undo(): Promise<void> {
		const session = this.session;
		if (!session) return;
		if (this.busy) {
			this.toast("wait for the current turn to finish", "warning");
			return;
		}
		const messages = await session.messages();
		const revertedID = session.revert?.messageID;
		const lastUser = messages
			.filter((message) => message.role === "user" && message.text.trim().length > 0 && message.id !== revertedID)
			.at(-1);
		if (!lastUser) {
			this.toast("nothing to undo", "warning");
			return;
		}
		try {
			await session.stageRevert(lastUser.id);
			this.composer.setText(lastUser.text);
			this.shell.focusComposer();
			await this.reloadTranscript();
			await this.refreshFooter();
			void this.refreshSidebar();
			this.toast("message reverted · /redo to restore", "info");
		} catch (error) {
			this.lastError = String((error as Error).message ?? error);
			this.toast(this.lastError, "error");
		}
	}

	private async redo(): Promise<void> {
		const session = this.session;
		if (!session?.revert) {
			this.toast("nothing to redo", "info");
			return;
		}
		try {
			await session.clearRevert();
			await this.reloadTranscript();
			await this.refreshFooter();
			void this.refreshSidebar();
			this.toast("messages restored", "success");
		} catch (error) {
			this.lastError = String((error as Error).message ?? error);
			this.toast(this.lastError, "error");
		}
	}

	private async reloadTranscript(): Promise<void> {
		const session = this.session;
		if (!session) return;
		await this.attachSession(session);
	}

	private scheduleUpdateCheck(): void {
		if (!this.options.paths) return;
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const { compareVersions, fetchLatestRelease } = await import("../../update.js");
					const latest = await fetchLatestRelease(undefined, { userAgent: `io/${VERSION}` });
					if (latest && compareVersions(latest.version, VERSION) > 0) {
						this.updateAvailable = latest.version;
						this.shell.toast(`io ${latest.version} available · /update`, "info", { durationMs: 8_000 });
						void this.refreshSidebar();
					}
				} catch {
					// Offline is fine; the explicit /update command reports errors.
				}
			})();
		}, 1_500);
		timer.unref?.();
	}

	private openTerminal(): void {
		if (this.terminalPane?.isOpen) {
			this.terminalPane.close();
			return;
		}
		this.formSheet?.dispose();
		this.imagePanel?.dispose();
		this.terminalPane?.dispose();
		this.terminalPane = new IoTerminalPane({
			renderer: this.options.renderer,
			shell: this.shell,
			cwd: this.options.cwd,
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.suspendUi();
		this.terminalPane.open();
	}

	private previewImage(path?: string): void {
		const target = path ? resolve(this.options.cwd, path) : this.attachments.at(-1);
		if (!target) {
			this.toast("usage: /preview <path> (or attach an image first)", "warning");
			return;
		}
		try {
			if (!statSync(target).isFile()) throw new Error("not a file");
		} catch {
			this.toast(`not a file: ${target}`, "error");
			return;
		}
		this.formSheet?.dispose();
		this.imagePanel?.dispose();
		this.imagePanel = new IoImagePanel({
			renderer: this.options.renderer,
			shell: this.shell,
			onClose: () => this.resumeUi(),
		});
		this.suspendUi();
		this.imagePanel.open(target);
	}

	private async worktreesCommand(args: readonly string[]): Promise<void> {
		const [action, ...rest] = args;
		try {
			const worktrees = await this.options.engine.listWorktrees();
			if (!action || action === "list") {
				this.transcript.addNotice(
					["Worktrees", ...(worktrees.length === 0 ? [" none"] : worktrees.map((worktree, index) => ` ${index + 1}. ${worktree.directory}`))].join("\n"),
					"info",
				);
				return;
			}
			if (action === "new") {
				const worktree = await this.options.engine.createWorktree(rest.join(" ").trim() || undefined);
				this.transcript.addNotice(`worktree created: ${worktree.directory}`, "success");
				return;
			}
			const target = rest[0];
			if (!target) {
				this.toast(`usage: /worktrees ${action} <path|index>`, "warning");
				return;
			}
			const selected = /^\d+$/.test(target)
				? worktrees[Number(target) - 1]
				: worktrees.find((worktree) => worktree.directory === target || worktree.directory.endsWith(`/${target}`));
			if (!selected) {
				this.toast(`unknown worktree: ${target}`, "warning");
				return;
			}
			if (action === "switch") {
				await this.changeDirectory(selected.directory);
				return;
			}
			if (action === "remove") {
				await this.options.engine.removeWorktree(selected.directory);
				this.transcript.addNotice(`worktree removed: ${selected.directory}`, "success");
				return;
			}
			this.toast(`usage: /worktrees [list|new|switch|remove]`, "warning");
		} catch (error) {
			this.toast(String((error as Error).message ?? error), "error");
		}
	}

	private async openMcp(): Promise<void> {
		this.mcpPanel?.dispose();
		this.mcpPanel = new IoMcpPanel({
			renderer: this.options.renderer,
			shell: this.shell,
			load: () => this.options.engine.listMcp(),
			onConnect: async (server) => {
				await this.options.engine.connectMcp(server.name);
			},
			onDisconnect: async (server) => {
				await this.options.engine.disconnectMcp(server.name);
			},
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.suspendUi();
		await this.mcpPanel.open();
	}

	private async openSkills(): Promise<void> {
		const skills = await this.options.engine.listSkills();
		if (skills.length === 0) {
			this.toast("no skills found", "info");
			return;
		}
		this.formSheet?.dispose();
		this.imagePanel?.dispose();
		this.terminalPane?.dispose();
		this.skillsPanel?.dispose();
		this.skillsPanel = new IoSkillsPanel({
			renderer: this.options.renderer,
			shell: this.shell,
			skills,
			onSelect: async (skill) => {
				try {
					await this.session?.activateSkill(skill.id);
					this.toast(`skill ${skill.name} activated`, "success");
				} catch (error) {
					this.toast(String((error as Error).message ?? error), "error");
				}
			},
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.suspendUi();
		this.skillsPanel.open();
	}

	private attachFile(path: string): void {
		if (!path.trim()) {
			this.toast("usage: /attach <path>", "warning");
			return;
		}
		const target = resolve(this.options.cwd, path.trim());
		try {
			if (!statSync(target).isFile()) throw new Error("not a file");
		} catch {
			this.toast(`not a file: ${target}`, "error");
			return;
		}
		this.attachments.push(target);
		this.toast(`attached ${basename(target)}`, "success");
		void this.refreshFooter();
	}

	private listAttachments(): void {
		if (this.attachments.length === 0) {
			this.transcript.addNotice("no attachments", "info");
			return;
		}
		this.transcript.addNotice(`Attachments\n${this.attachments.map((file) => ` ${file}`).join("\n")}`, "info");
	}

	private async searchMessages(query: string): Promise<void> {
		if (!query.trim() || !this.session) {
			this.toast("usage: /search <text>", "warning");
			return;
		}
		const needle = query.toLowerCase();
		const messages = await this.session.messages();
		const matches = messages.filter((message) => message.text.toLowerCase().includes(needle)).slice(-20);
		if (matches.length === 0) {
			this.toast("no matches", "info");
			return;
		}
		this.transcript.addNotice(
			`Search · ${query}\n${matches.map((message) => ` ${message.role}: ${message.text.replace(/\s+/g, " ").slice(0, 140)}`).join("\n")}`,
			"info",
		);
	}

	private async showDebug(): Promise<void> {
		const [mcps, skills] = await Promise.all([
			this.options.engine.listMcp().catch(() => []),
			this.options.engine.listSkills().catch(() => []),
		]);
		const lines = [
			`io ${VERSION} · engine ${this.options.engine.kind}`,
			`cwd ${this.options.cwd}`,
			`session ${this.session?.id ?? "—"}`,
			`agents ${this.agentList.length} · mcp ${mcps.length} · skills ${skills.length}`,
			`theme ${this.appearance.themePreference} · verbosity ${this.appearance.verbosity}`,
			`update ${this.updateAvailable ?? "none"}`,
		];
		this.transcript.addNotice(`Debug\n${lines.map((line) => ` ${line}`).join("\n")}`, "info");
	}

	private async showUsage(): Promise<void> {
		try {
			const usage = await this.options.engine.usage();
			if (!usage) {
				this.toast("no usage limits available", "info");
				return;
			}
			const lines = [`Usage${usage.name ? ` · ${usage.name}` : ""}`];
			for (const [label, meter] of Object.entries(usage.go ?? {})) {
				const value = meter as { percent: number; limited: boolean };
				lines.push(` ${label.padEnd(8)} ${value.percent.toFixed(1)}%${value.limited ? " · limited" : ""}`);
			}
			for (const budget of usage.budgets) {
				lines.push(
					` budget ${budget.id}  $${budget.spent.toFixed(2)} / $${budget.limit.toFixed(2)}`,
				);
			}
			if (usage.url) lines.push(` ${usage.url}`);
			this.transcript.addNotice(lines.join("\n"), "info");
		} catch (error) {
			this.toast(String((error as Error).message ?? error), "error");
		}
	}

	private togglePin(): void {
		const session = this.session;
		if (!session) return;
		const pinned = this.tabs.togglePin(session.id);
		this.toast(`session ${pinned ? "pinned" : "unpinned"}`, "info");
		void this.refreshSidebar();
	}

	private clearScreen(): void {
		this.transcript.clear();
		this.options.renderer.requestRender();
	}

	private persistAppearance(): void {
		const paths = this.options.paths;
		if (!paths) return;
		try {
			const config = loadConfig(paths).config;
			saveConfig(paths, { ...config, appearance: this.appearance.toConfig() });
		} catch (error) {
			this.toast(String((error as Error).message ?? error), "error");
		}
	}

	private openThemes(): void {
		const options: readonly IoThemeOption[] = [
			{ id: "io", label: "io", description: "Near-black canvas with a cool accent" },
			{ id: "io-light", label: "io light", description: "Light canvas with a deep blue accent" },
			{ id: "system", label: "System", description: "Follow COLORFGBG when available" },
			{ id: "dark", label: "Dark", description: "Use the dark io palette" },
			{ id: "light", label: "Light", description: "Use the light io palette" },
		];
		this.themePicker?.dispose();
		this.themePicker = new IoThemePicker({
			renderer: this.options.renderer,
			shell: this.shell,
			options,
			current: this.appearance.themePreference,
			onPreview: (id) => {
				this.appearance.setTheme(id);
				this.appearance.applyToShell(this.shell);
				this.appearance.applyToTranscript(this.transcript);
			},
			onSelect: (id) => {
				this.appearance.setTheme(id);
				this.appearance.applyToShell(this.shell);
				this.appearance.applyToTranscript(this.transcript);
				this.persistAppearance();
				this.toast(`theme: ${id}`, "success");
			},
			onClose: () => this.resumeUi(),
		});
		this.suspendUi();
		this.themePicker.open();
	}

	private settingsRows(): readonly IoSettingRow[] {
		return [
			{ id: "theme", label: "Theme", value: this.appearance.themePreference },
			{ id: "verbosity", label: "Verbosity", value: this.appearance.verbosity },
			{ id: "thinking", label: "Thinking", value: this.appearance.thinking ? "shown" : "hidden" },
			{ id: "tps", label: "Tokens/second", value: this.appearance.tps ? "shown" : "hidden" },
			{ id: "markdown", label: "Markdown", value: this.appearance.markdown },
			{ id: "toolOutput", label: "Tool output", value: this.appearance.toolOutput },
		];
	}

	private openSettings(): void {
		if (!this.settingsPanel) {
			this.settingsPanel = new IoSettingsPanel({
				renderer: this.options.renderer,
				shell: this.shell,
				rows: this.settingsRows(),
				onActivate: (id) => this.cycleSetting(id),
				onClose: () => this.resumeUi(),
			});
		}
		this.settingsPanel.setRows(this.settingsRows());
		this.suspendUi();
		this.settingsPanel.open();
	}

	private cycleSetting(id: string): void {
		if (id === "theme") {
			const index = THEMES.indexOf(this.appearance.themePreference);
			this.appearance.setTheme(THEMES[(index + 1) % THEMES.length] ?? "io");
		} else if (id === "verbosity") {
			this.appearance.cycleVerbosity();
		} else if (id === "thinking") {
			this.appearance.setThinking(!this.appearance.thinking);
		} else if (id === "tps") {
			this.appearance.setTps(!this.appearance.tps);
		} else if (id === "markdown") {
			this.appearance.setMarkdown(this.appearance.markdown === "rendered" ? "source" : "rendered");
		} else if (id === "toolOutput") {
			this.appearance.setToolOutput(this.appearance.toolOutput === "expanded" ? "collapsed" : "expanded");
		}
		this.appearance.applyToShell(this.shell);
		this.appearance.applyToTranscript(this.transcript);
		this.persistAppearance();
		this.settingsPanel?.setRows(this.settingsRows());
	}

	private toggleSidebar(): void {
		const visible = !this.shell.isSidebarVisible;
		this.shell.toggleSidebar(visible);
		if (visible) void this.refreshSidebar();
		this.toast(`sidebar ${visible ? "shown" : "hidden"}`, "info");
	}

	private async refreshSidebar(): Promise<void> {
		if (this.disposed || !this.shell.isSidebarVisible) return;
		const session = this.session;
		if (!session) {
			this.shell.setSidebar(["Session", " no active session"]);
			return;
		}
		const [stats, branch, children] = await Promise.all([
			session.stats().catch(() => undefined),
			getGitBranchAsync(this.options.cwd),
			this.options.engine
				.listSessions({ directory: this.options.cwd, parentID: session.id, limit: 10 })
				.catch(() => []),
		]);
		const summary = this.sessionList.find((entry) => entry.id === session.id);
		const model = session.model;
		const context =
			stats?.contextPercent === null || stats?.contextPercent === undefined
				? "—"
				: `${stats.contextPercent.toFixed(1)}%`;
		const lines: string[] = [
			"Session",
			` ${summary?.title ?? shortSessionId(session.id)}`,
			"",
			"Agent",
			` ${this.agentName(session.agent) ?? "—"}`,
			"",
			"Model",
			` ${model ? `${model.provider}/${model.id}` : "—"}`,
			` effort ${model?.variant ?? "default"}`,
			"",
			"Context",
			` ${context} · ${stats ? `${formatTokens(stats.tokens.input)} in · ${formatTokens(stats.tokens.output)} out` : "—"}`,
			` ${stats && stats.cost > 0 ? `$${stats.cost.toFixed(4)}` : "—"}`,
			"",
			"Directory",
			` ${this.options.cwd}`,
			` ${branch ?? "—"}`,
		];
		if (this.todos.length > 0) {
			lines.push("", "Plan");
			for (const todo of this.todos.slice(0, 6)) {
				const marker =
					todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[~]" : todo.status === "cancelled" ? "[-]" : "[ ]";
				lines.push(` ${marker} ${todo.content}`);
			}
		}
		if (children.length > 0) {
			lines.push("", "Subagents");
			for (const child of children.slice(0, 5)) {
				lines.push(` ${child.busy ? "•" : " "} ${child.title} · ${child.agent ?? "agent"}`);
			}
		}
		if (this.updateAvailable) {
			lines.push("", "Update", ` io ${this.updateAvailable} available`, " /update to install");
		}
		lines.push("", "Queue", ` ${this.composer.queued.length} pending`);
		if (this.disposed) return;
		this.shell.setSidebar(lines);
	}

	private openTimeline(): void {
		const entries = this.transcript.userMessages;
		if (entries.length === 0) {
			this.toast("no user messages yet", "warning");
			return;
		}
		this.formSheet?.dispose();
		this.imagePanel?.dispose();
		this.terminalPane?.dispose();
		this.skillsPanel?.dispose();
		this.mcpPanel?.dispose();
		this.settingsPanel?.dispose();
		this.themePicker?.dispose();
		this.subagentPicker?.dispose();
		this.errorPanel?.dispose();
		this.timeline?.dispose();
		this.timeline = new IoTimeline({
			renderer: this.options.renderer,
			shell: this.shell,
			entries,
			onSelect: (index) => {
				this.transcript.focusUserMessage(index);
			},
			onClose: () => this.resumeUi(),
		});
		this.suspendUi();
		this.timeline.open();
	}

	private async openConnect(): Promise<void> {
		if (this.options.remote) {
			this.toast("auth is managed by the remote OpenCode server", "info");
			return;
		}
		const paths = this.options.paths;
		if (!paths) {
			this.toast("auth is unavailable in this session", "warning");
			return;
		}
		this.formSheet?.dispose();
		this.imagePanel?.dispose();
		this.terminalPane?.dispose();
		this.skillsPanel?.dispose();
		this.mcpPanel?.dispose();
		this.settingsPanel?.dispose();
		this.themePicker?.dispose();
		this.subagentPicker?.dispose();
		this.errorPanel?.dispose();
		this.timeline?.dispose();
		this.statusPanel?.dispose();
		this.connectDialog?.dispose();
		const { createAuthHost } = await import("../../commands/next-auth.js");
		this.connectDialog = new IoConnectDialog({
			renderer: this.options.renderer,
			shell: this.shell,
			cwd: this.options.cwd,
			createHost: () => createAuthHost(paths),
			onStatus: (message) => this.toast(message, "success"),
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.suspendUi();
		await this.connectDialog.open();
	}

	private async cycleAgent(): Promise<void> {
		const agents = selectableAgents(this.agentList);
		if (agents.length === 0 || !this.session) {
			this.toast("no primary agents available", "warning");
			return;
		}
		const current = agents.findIndex((agent) => agent.id === this.session?.agent);
		const next = agents[(current + 1) % agents.length];
		if (!next) return;
		await this.applyAgent(next);
	}

	private async runInlineShell(command: string): Promise<void> {
		if (!command) {
			this.transcript.addNotice("usage: !command", "info");
			return;
		}
		this.transcript.addNotice(`$ ${command}`, "info");
		try {
			const result = await runShellCommand(command, {
				cwd: this.options.cwd,
				envNames: this.options.envNames,
			});
			const text = result.output.trimEnd() || "(no output)";
			this.transcript.addNotice(text, result.exitCode === 0 ? "info" : "error");
		} catch (error) {
			this.transcript.addNotice(String((error as Error).message ?? error), "error");
		}
	}

	private async newSession(): Promise<void> {
		const model = this.session?.model;
		const agent = this.session?.agent;
		const session = await this.options.engine.createSession({
			directory: this.options.cwd,
			model,
			...(agent ? { agent } : {}),
		});
		await this.attachSession(session);
		await this.refreshSessions();
		this.toast("new session", "success");
	}

	private async selectTab(slot: number): Promise<void> {
		const target = this.tabs.sessionAt(slot);
		if (!target || target.id === this.session?.id) return;
		const session = await this.options.engine.resumeSession(target.id);
		await this.attachSession(session);
		await this.refreshSessions();
	}

	private async closeTab(slot: number): Promise<void> {
		const target = this.tabs.sessionAt(slot);
		if (!target) return;
		const active = target.id === this.session?.id;
		const next = this.tabs.closeSlot(slot);
		if (active && next && next.id !== this.session?.id) {
			const session = await this.options.engine.resumeSession(next.id);
			await this.attachSession(session);
			await this.refreshSessions();
		}
	}

	private async cycleTab(delta: number): Promise<void> {
		const tabs = this.tabs.current;
		if (tabs.length < 2) return;
		const index = tabs.findIndex((session) => session.id === this.session?.id);
		const next = tabs[(index + delta + tabs.length) % tabs.length];
		if (!next || next.id === this.session?.id) return;
		const session = await this.options.engine.resumeSession(next.id);
		await this.attachSession(session);
		await this.refreshSessions();
	}

	private async continueSession(): Promise<void> {		const sessions = await this.options.engine.listSessions({ directory: this.options.cwd, limit: 5 });
		const latest = sessions[0];
		if (!latest) {
			this.transcript.addNotice("no sessions to continue", "warning");
			return;
		}
		if (latest.id === this.session?.id) {
			this.toast("already on the latest session", "info");
			return;
		}
		const session = await this.options.engine.resumeSession(latest.id);
		await this.attachSession(session);
		await this.refreshSessions();
		this.toast(`continued ${shortSessionId(latest.id)}`, "success");
	}

	private async update(): Promise<void> {
		this.toast("checking for updates", "info");
		try {
			const { updateCommand } = await import("../../commands/next-update.js");
			const code = await updateCommand({
				stdout: (text) => {
					const value = text.trim();
					if (value) this.transcript.addNotice(value, "info");
				},
				stderr: (text) => {
					const value = text.trim();
					if (value) this.transcript.addNotice(value, "error");
				},
			});
			if (code !== 0) this.toast("update check failed", "error");
		} catch (error) {
			this.toast(String((error as Error).message ?? error), "error");
		}
	}

	private async changeDirectory(input?: string): Promise<void> {
		if (!input) {
			this.transcript.addNotice(`cwd ${this.options.cwd}`, "info");
			return;
		}
		const home = process.env.HOME;
		const expanded =
			input === "~" ? (home ?? input) : input.startsWith("~/") && home ? join(home, input.slice(2)) : input;
		const target = resolve(this.options.cwd, expanded);
		let directory: boolean;
		try {
			directory = statSync(target).isDirectory();
		} catch {
			this.transcript.addNotice(`not a directory: ${target}`, "error");
			return;
		}
		if (!directory) {
			this.transcript.addNotice(`not a directory: ${target}`, "error");
			return;
		}
		try {
			await this.session?.move(target);
		} catch (error) {
			this.transcript.addNotice(`cannot change directory: ${String((error as Error).message ?? error)}`, "error");
			return;
		}
		this.options.cwd = target;
		await this.refreshSessions();
		await this.refreshFooter();
		this.toast(`cwd ${target}`, "success");
	}

	private async compact(): Promise<void> {
		if (!this.session) return;
		await this.session.compact();
		this.toast("compaction queued", "info");
	}

	private async openModels(): Promise<void> {
		const models = await this.options.engine.listModels();
		const current = this.session?.model;
		this.variantPicker?.dispose();
		this.modelPicker?.dispose();
		this.modelPicker = new IoModelPicker({
			renderer: this.options.renderer,
			shell: this.shell,
			models,
			current,
			onSelect: (model, variant) => this.chooseModel(model, variant),
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.suspendUi();
		this.modelPicker.open();
	}

	private async chooseModel(model: EngineModel, variant?: string): Promise<void> {
		if (model.variants.length === 0) {
			await this.applyModel(model, undefined);
			return;
		}
		this.openVariantPicker(model, variant);
	}

	private openVariantPicker(model: EngineModel, preferred?: string): void {
		const current = this.session?.model;
		const currentVariant = current?.provider === model.provider && current.id === model.id ? current.variant : undefined;
		this.variantPicker?.dispose();
		this.variantPicker = new IoVariantPicker({
			renderer: this.options.renderer,
			shell: this.shell,
			model,
			current: preferred ?? currentVariant,
			onSelect: (variant) => this.applyModel(model, variant),
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.suspendUi();
		this.variantPicker.open();
	}

	private async applyModel(model: EngineModel, variant?: string): Promise<void> {
		await this.session?.setModel({
			provider: model.provider,
			id: model.id,
			...(variant ? { variant } : {}),
		});
		await this.refreshFooter();
		this.toast(`model ${model.provider}/${model.id}${variant ? ` · ${variant}` : ""}`, "success");
	}

	private async cycleVariant(): Promise<void> {
		const current = this.session?.model;
		if (!current) return;
		const models = await this.options.engine.listModels();
		const model = models.find((entry) => entry.provider === current.provider && entry.id === current.id);
		if (!model || model.variants.length === 0) {
			this.toast("this model has no variants", "warning");
			return;
		}
		const index = current.variant ? model.variants.indexOf(current.variant) : -1;
		const variant = model.variants[(index + 1) % model.variants.length];
		if (!variant) return;
		await this.applyModel(model, variant);
	}

	private async openSessions(): Promise<void> {
		this.sessionList = await this.options.engine.listSessions({ directory: this.options.cwd, limit: 100 });
		this.sessionSwitcher?.dispose();
		this.sessionSwitcher = new IoSessionSwitcher({
			renderer: this.options.renderer,
			shell: this.shell,
			sessions: this.sessionList,
			activeID: this.session?.id,
			onSearch: async (query) =>
				this.options.engine.listSessions({ directory: this.options.cwd, search: query, limit: 100 }),
			onArchive: async (entry) => {
				await this.options.engine.archiveSession(entry.id, true);
				this.toast(`archived ${shortSessionId(entry.id)}`, "success");
			},
			onSelect: async (entry) => {
				const session = await this.options.engine.resumeSession(entry.id);
				await this.attachSession(session);
				await this.refreshSessions();
			},
			onRename: async (entry, title) => {
				await this.options.engine.renameSession(entry.id, title);
				await this.refreshSessions();
			},
			onDelete: async (entry) => {
				await this.options.engine.deleteSession(entry.id);
				await this.refreshSessions();
			},
			onFork: async (entry) => {
				const source = await this.options.engine.resumeSession(entry.id);
				const forked = await source.fork();
				await source.dispose();
				await this.attachSession(forked);
				await this.refreshSessions();
			},
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.suspendUi();
		this.sessionSwitcher.open();
	}

	private async openDiff(pathFilter?: string): Promise<void> {
		this.diffViewer?.dispose();
		this.diffViewer = new IoDiffViewer({
			renderer: this.options.renderer,
			shell: this.shell,
			cwd: this.options.cwd,
			fileFilter: pathFilter,
			turnDiff: async () => (await this.session?.diff() ?? []).map((file) => ({ path: file.path, patch: file.patch })),
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.suspendUi();
		await this.diffViewer.open("working");
	}

	private openQueue(): void {
		this.queueManager?.dispose();
		this.queueManager = new IoQueueManager({
			renderer: this.options.renderer,
			shell: this.shell,
			queue: this.composer.queued,
			onChange: (queue) => this.composer.setQueue(queue),
			onSteer: async (prompt) => {
				await this.submit(prompt, "prompt", "steer");
			},
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.suspendUi();
		this.queueManager.open();
	}

	private openPalette(): void {
		if (!this.palette) {
			this.palette = new IoCommandPalette({
				renderer: this.options.renderer,
				shell: this.shell,
				commands: [...this.commands, ...this.slashCommands()],
				onClose: () => this.resumeUi(),
				onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
			});
		}
		this.suspendUi();
		this.palette.open();
	}

	private slashCommands(): IoCommand[] {
		return this.allCompletions().map((command) => ({
			id: `slash:${command.value}`,
			title: command.value,
			description: command.description,
			keys: [],
			run: () => this.runCommand(command.value),
		}));
	}

	private suspendUi(): void {
		this.autocomplete.hide();
		this.keymap.setSuspended(true);
	}

	private resumeUi(): void {
		this.keymap.setSuspended(false);
		this.composer.textarea.focus();
		this.shell.focusComposer();
	}

	private closeTransientOverlays(): void {
		this.palette?.close();
		this.agentPicker?.close();
		this.formSheet?.close();
		this.imagePanel?.close();
		this.terminalPane?.close();
		this.skillsPanel?.close();
		this.mcpPanel?.close();
		this.settingsPanel?.close();
		this.themePicker?.close();
		this.subagentPicker?.close();
		this.errorPanel?.close();
		this.timeline?.close();
		this.statusPanel?.close();
		this.connectDialog?.close();
		this.variantPicker?.close();
		this.modelPicker?.close();
		this.sessionSwitcher?.close();
		this.diffViewer?.close();
		this.queueManager?.close();
	}

	private async refreshSessions(): Promise<void> {
		if (this.disposed) return;
		this.sessionList = await this.options.engine.listSessions({ directory: this.options.cwd });
		if (this.disposed) return;
		this.tabs.setSessions(this.sessionList, this.session?.id);
	}

	private allCompletions(): readonly IoCompletionItem[] {
		return [
			...SLASH_COMMANDS,
			...this.commandList.map((command) => ({
				value: `/${command.name}`,
				description: command.description ?? "project command",
				kind: "command" as const,
			})),
		];
	}

	private async runCustomCommand(command: EngineCommand, text: string): Promise<void> {
		const session = this.session;
		if (!session) return;
		this.transcript.addUser(`/${command.name}${text ? ` ${text}` : ""}`);
		try {
			await session.runCommand(command.name, text);
		} catch (error) {
			this.lastError = String((error as Error).message ?? error);
			this.toast(this.lastError, "error");
		}
	}

	private async permissionsCommand(args: readonly string[]): Promise<void> {
		if (args[0] === "remove" && args[1]) {
			try {
				await this.options.engine.removeSavedPermission(args[1]);
				this.toast("permission rule removed", "success");
			} catch (error) {
				this.toast(String((error as Error).message ?? error), "error");
			}
			return;
		}
		const rules = await this.options.engine.listSavedPermissions().catch(() => []);
		this.transcript.addNotice(
			[
				"Saved permissions",
				...(rules.length === 0
					? [" none"]
					: rules.map((rule) => ` ${rule.id}  ${rule.action} ${rule.resource}`)),
			].join("\n"),
			"info",
		);
	}

	private mentionAgents(text: string): readonly string[] {
		const mentions = new Set<string>();
		for (const match of text.matchAll(/@([A-Za-z0-9_./-]+)/g)) {
			const id = match[1];
			if (id && this.agentList.some((agent) => agent.id === id && !agent.hidden && agent.mode !== "primary")) {
				mentions.add(id);
			}
		}
		return [...mentions];
	}

	private agentName(agentID: string | undefined): string | undefined {
		if (!agentID) return undefined;
		return this.agentList.find((agent) => agent.id === agentID)?.name ?? agentID;
	}

	private async refreshFooter(): Promise<void> {
		if (this.disposed) return;
		const session = this.session;
		const model = session?.model;
		const branch = await getGitBranchAsync(this.options.cwd);
		let context: string | undefined;
		let tokens: string | undefined;
		let cost: string | undefined;
		if (session) {
			const stats = await session.stats().catch(() => undefined);
			if (stats) {
				context =
					stats.contextPercent === null
						? undefined
						: `${stats.contextPercent.toFixed(stats.contextPercent < 10 ? 1 : 0)}%`;
				tokens = `${formatTokens(stats.tokens.input)} in · ${formatTokens(stats.tokens.output)} out`;
				cost = stats.cost > 0 ? `$${stats.cost.toFixed(4)}` : undefined;
			}
		}
		this.shell.setFooter({
			cwd: formatCwdForFooter(this.options.cwd, process.env.HOME),
			branch,
			agent: this.agentName(session?.agent),
			model: model ? `${model.provider}/${model.id}${model.variant ? ` (${model.variant})` : ""}` : undefined,
			context,
			tokens,
			cost,
			queue: this.composer.queued.length,
		});
		if (this.disposed) return;
		this.shell.setHeader({ cwd: this.options.cwd, branch });
		if (!this.busy) {
			const metadata = [
				session?.parentID ? "↳ subagent" : undefined,
				this.agentName(session?.agent),
				model ? `${model.provider}/${model.id}` : undefined,
				model?.variant ? `effort ${model.variant}` : undefined,
				context ? `ctx ${context}` : undefined,
				this.attachments.length > 0 ? `${this.attachments.length} attachment${this.attachments.length === 1 ? "" : "s"}` : undefined,
			].filter((value): value is string => typeof value === "string" && value.length > 0);
			this.shell.setComposerMetadata(metadata.join(" · "));
		}
	}

	private startWorking(): void {
		this.stopWorking();
		this.turnStartedAt = Date.now();
		this.spinFrame = 0;
		this.spinTimer = setInterval(() => {
			this.spinFrame += 1;
			this.updateWorkingFooter();
		}, 120);
		this.spinTimer.unref?.();
		this.updateWorkingFooter();
	}

	private updateWorkingFooter(): void {
		if (!this.busy) return;
		const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		const frame = frames[this.spinFrame % frames.length] ?? "⠋";
		const elapsed = Math.max(0, Math.floor((Date.now() - this.turnStartedAt) / 1_000));
		const hint = this.interruptArmed ? "esc again to interrupt" : "esc interrupt";
		this.shell.setComposerMetadata(
			`${frame} working · ${elapsed}s · ${hint}`,
			this.interruptArmed ? this.appearance.theme.warning : this.appearance.theme.muted,
		);
	}

	private stopWorking(): void {
		if (this.spinTimer !== undefined) clearInterval(this.spinTimer);
		this.spinTimer = undefined;
	}

	private armInterrupt(): void {
		this.interruptArmed = true;
		if (this.interruptTimer !== undefined) clearTimeout(this.interruptTimer);
		this.interruptTimer = setTimeout(() => this.disarmInterrupt(), 5_000);
		this.interruptTimer.unref?.();
		this.updateWorkingFooter();
	}

	private disarmInterrupt(): void {
		if (this.interruptTimer !== undefined) clearTimeout(this.interruptTimer);
		this.interruptTimer = undefined;
		this.interruptArmed = false;
		if (this.busy) this.updateWorkingFooter();
	}

	private async interrupt(): Promise<void> {
		if (!this.busy) return;
		if (!this.interruptArmed) {
			this.armInterrupt();
			return;
		}
		this.disarmInterrupt();
		await this.session?.abort();
	}

	private toggleToolOutput(): void {
		this.toolOutputExpanded = !this.toolOutputExpanded;
		this.appearance.setToolOutput(this.toolOutputExpanded ? "expanded" : "collapsed");
		this.transcript.setToolOutputExpanded(this.toolOutputExpanded);
		this.toast(`tool output ${this.toolOutputExpanded ? "expanded" : "collapsed"}`, "info");
	}

	private toggleThinking(): void {
		this.appearance.setThinking(!this.appearance.thinking);
		this.appearance.applyToTranscript(this.transcript);
		this.toast(`thinking ${this.appearance.thinking ? "shown" : "hidden"}`, "info");
	}

	private cycleVerbosity(): void {
		const level = this.appearance.cycleVerbosity();
		this.appearance.applyToTranscript(this.transcript);
		this.toast(`verbosity: ${level}`, "info");
	}

	private toggleTps(): void {
		this.appearance.setTps(!this.appearance.tps);
		this.appearance.applyToShell(this.shell);
		this.toast(`tokens/second ${this.appearance.tps ? "on" : "off"}`, "info");
	}

	private toast(message: string, kind: "info" | "success" | "warning" | "error" | "permission"): void {
		this.shell.toast(message, kind);
	}

	private commandHandlers(): Partial<Record<string, () => void | Promise<void>>> {
		return {
			"command.palette.show": () => this.openPalette(),
			"composer.complete": () => {
				if (this.autocomplete.visible) {
					this.autocomplete.accept();
					return;
				}
				this.composer.acceptCompletion();
			},
			"model.list": () => this.openModels(),
			"model.variant.cycle": () => this.cycleVariant(),
			"agent.list": () => this.openAgents(),
			"agent.cycle": () => this.cycleAgent(),
			"session.list": () => this.openSessions(),
			"session.new": () => this.newSession(),
			"session.tab.next": () => this.cycleTab(1),
			"session.tab.previous": () => this.cycleTab(-1),
			...Object.fromEntries(
				Array.from({ length: 9 }, (_, index) => [
					`session.tab.select.${index + 1}`,
					() => this.selectTab(index + 1),
				]),
			),
			"session.compact": () => this.compact(),
			"status.show": () => this.openStatus(),
			"session.timeline": () => this.openTimeline(),
			"session.pin.toggle": () => this.togglePin(),
			"session.subagent.next": () => this.openSubagents(),
			"session.subagent.open": () => this.openSubagents(),
			"session.child.next": () => this.cycleSibling(1),
			"session.child.previous": () => this.cycleSibling(-1),
			"session.parent": () => this.openParent(),
			"sidebar.toggle": () => this.toggleSidebar(),
			"error.show": () => this.openError(),
			"session.undo": () => this.undo(),
			"session.redo": () => this.redo(),
			"messages.copy": () => this.copyCommand(),
			"prompt.editor": () => this.openEditor(),
			"prompt.stash": () => this.stashCommand(),
			"prompt.stash.pop": () => this.stashCommand("pop"),
			"settings.open": () => this.openSettings(),
			"theme.list": () => this.openThemes(),
			"screen.clear": () => this.clearScreen(),
			"open.menu": () => this.openSessions(),
			"mcp.list": () => this.openMcp(),
			"skills.list": () => this.openSkills(),
			"usage.show": () => this.showUsage(),
			"terminal.toggle": () => this.openTerminal(),
			"session.interrupt": () => this.interrupt(),
			"prompt.queue": () => {
				this.composer.submit("queue");
			},
			"queued.prompts": () => this.openQueue(),
			"diff.open": () => this.openDiff(),
			"tool.output.toggle": () => this.toggleToolOutput(),
			"thinking.toggle": () => this.toggleThinking(),
			"verbosity.cycle": () => this.cycleVerbosity(),
			"tps.toggle": () => this.toggleTps(),
			"theme.switch": () => this.openThemes(),
			"which-key.toggle": () => this.keymap.showAllBindings(),
			"app.exit": () => this.shutdown(0),
		};
	}
}


function parseTodos(input: unknown): readonly IoShellTodo[] | undefined {
	if (!input || typeof input !== "object") return undefined;
	const raw = (input as { todos?: unknown }).todos;
	if (!Array.isArray(raw)) return undefined;
	const todos: IoShellTodo[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const value = entry as { content?: unknown; status?: unknown };
		const content = typeof value.content === "string" ? value.content.trim() : "";
		const status =
			value.status === "completed" || value.status === "in_progress" || value.status === "cancelled"
				? value.status
				: value.status === "pending"
					? "pending"
					: undefined;
		if (!content || !status) continue;
		todos.push({ content, status });
	}
	return todos;
}

export interface IoNextAppFromPathsOptions {
	cwd: string;
	paths: IoPaths;
	renderer: CliRenderer;
	server?: { url: string; token?: string };
	appearance?: IoAppearanceConfig;
	sessionID?: string;
	model?: EngineModelRef;
	envNames?: readonly string[];
	onExit?: (code: number) => void;
}

export interface IoEngineFromPathsOptions {
	cwd: string;
	paths: IoPaths;
	envNames?: readonly string[];
	server?: { url: string; token?: string };
}

/** Build the embedded OpenCode engine with io's shell and storage. */
export async function createIoEngine(options: IoEngineFromPathsOptions): Promise<AgentEngine> {
	ensureIoDirectories(options.paths);
	const models = syncModelsConfig(options.paths);
	for (const warning of models.warnings) process.stderr.write(`io: ${warning}\n`);
	const server = options.server ?? (process.env.IO_SERVER_URL
		? { url: process.env.IO_SERVER_URL, token: process.env.IO_SERVER_TOKEN }
		: undefined);
	const engine = await OpenCodeEngine.create({
		cwd: options.cwd,
		configDir: join(options.paths.configDir, "opencode"),
		databasePath: join(options.paths.dataDir, "opencode.db"),
		...(server ? { server } : {}),
		plugins: [createIoSecurityPlugin({ cwd: options.cwd, envNames: options.envNames })],
	});
	// Wait for the built-in agent plugin so title/compaction/summary and the
	// general/explore subagents exist before the first session is created.
	await engine.listAgents();
	return engine;
}

/** Production entrypoint: build the embedded OpenCode engine with io's shell tool. */
export async function createIoNextApp(options: IoNextAppFromPathsOptions): Promise<IoNextApp> {
	const engine = await createIoEngine(options);
	return IoNextApp.create({
		cwd: options.cwd,
		renderer: options.renderer,
		engine,
		paths: options.paths,
		remote: Boolean(options.server ?? process.env.IO_SERVER_URL),
		appearance: options.appearance,
		sessionID: options.sessionID,
		model: options.model,
		envNames: options.envNames,
		onExit: options.onExit,
	});
}
