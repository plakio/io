import { join } from "node:path";
import type { CliRenderer } from "@opentui/core";
import { getGitBranchAsync } from "../../git-diff.js";
import {
	ensureIoDirectories,
	type IoAppearanceConfig,
	type IoPaths,
	type IoThemePreference,
} from "../../config.js";
import { formatCwdForFooter, formatTokens, shortSessionId } from "../../format.js";
import { OpenCodeEngine } from "../../engine/opencode.js";
import { syncModelsConfig } from "../../engine/models-config.js";
import { createIoSecurityPlugin, runShellCommand } from "../../engine/shell-plugin.js";
import type {
	AgentEngine,
	EngineModelRef,
	EnginePermissionRequest,
	EngineSession,
	EngineSessionSummary,
	IoEvent,
} from "../../engine/types.js";
import { VERSION } from "../../version.js";
import { IoAppearance } from "./appearance.js";
import { IoCommandPalette } from "./command-palette.js";
import { createIoCommands } from "./commands.js";
import type { IoCommand } from "./keymap.js";
import { IoComposer } from "./composer.js";
import { IoDiffViewer } from "./diff-viewer.js";
import { IoKeymap } from "./keymap.js";
import { IoModelPicker } from "./model-picker.js";
import { IoPermissionSheet } from "./permission-sheet.js";
import { IoQueueManager } from "./queue-manager.js";
import { IoSessionSwitcher } from "./session-switcher.js";
import { IoSessionTabs } from "./session-tabs.js";
import { IoShell } from "./shell.js";
import { IoTranscript } from "./transcript.js";

export interface IoNextAppOptions {
	cwd: string;
	renderer: CliRenderer;
	engine: AgentEngine;
	appearance?: IoAppearanceConfig;
	sessionID?: string;
	model?: EngineModelRef;
	envNames?: readonly string[];
	onExit?: (code: number) => void;
}

const THEMES: readonly IoThemePreference[] = ["io", "io-light", "system", "dark", "light"];

const HELP = `Commands
  /help          Show this help
  /model         Select a model
  /sessions      Resume a session
  /new           Start a new session
  /compact       Compact the context
  /diff          Show git changes
  /queue         Manage queued prompts
  /quit          Exit io

Keys
  Ctrl+P         Command palette
  Ctrl+X m       Models
  Ctrl+X l       Sessions
  Ctrl+X d       Diff
  Ctrl+X q       Queue
  Ctrl+X o       Toggle tool output
  Ctrl+X t       Toggle thinking
  Ctrl+X v       Cycle verbosity
  Ctrl+X p       Toggle tokens per second
  Ctrl+X h       Switch theme
  Esc            Cancel generation / close overlay`;

/** Wires the new OpenTUI shell to an AgentEngine. */
export class IoNextApp {
	private readonly options: IoNextAppOptions;
	private readonly appearance: IoAppearance;
	private readonly shell: IoShell;
	private readonly transcript: IoTranscript;
	private readonly composer: IoComposer;
	private readonly tabs: IoSessionTabs;
	private readonly commands: readonly IoCommand[];
	private readonly keymap: IoKeymap;
	private session: EngineSession | undefined;
	private unsubscribe: (() => void) | undefined;
	private sessionList: readonly EngineSessionSummary[] = [];
	private palette: IoCommandPalette | undefined;
	private modelPicker: IoModelPicker | undefined;
	private sessionSwitcher: IoSessionSwitcher | undefined;
	private diffViewer: IoDiffViewer | undefined;
	private queueManager: IoQueueManager | undefined;
	private permissionSheet: IoPermissionSheet | undefined;
	private pendingPermission: EnginePermissionRequest | undefined;
	private toolOutputExpanded = false;
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
		});
		this.transcript = new IoTranscript({
			renderer: options.renderer,
			container: this.shell.transcriptContainer,
			theme: this.appearance.theme,
			showThinking: this.appearance.thinking,
		});
		this.appearance.applyToShell(this.shell);
		this.appearance.applyToTranscript(this.transcript);
		this.composer = new IoComposer({
			renderer: options.renderer,
			textarea: this.shell.composer,
			onSubmit: (text, mode, delivery) => {
				void this.submit(text, mode, delivery);
			},
			onQueueChange: (queue) => this.shell.setFooter({ queue: queue.length }),
		});
		this.tabs = new IoSessionTabs(this.shell, engine);
		this.exitPromise = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
		this.commands = createIoCommands(this.commandHandlers());
		this.keymap = new IoKeymap({
			renderer: options.renderer,
			shell: this.shell,
			commands: this.commands,
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
		await this.tabs.refresh(this.session?.id);
		return this.exitPromise;
	}

	get currentSession(): EngineSession | undefined {
		return this.session;
	}

	async submit(text: string, mode: "prompt" | "shell" | "command", delivery: "steer" | "queue" = "steer"): Promise<void> {
		const prompt = text.trim();
		if (!prompt || !this.session) return;
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
			await this.session.prompt(prompt, { delivery, wait: false });
		} catch (error) {
			this.toast(String((error as Error).message ?? error), "error");
		}
	}

	async shutdown(code = 0): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		try {
			await this.session?.dispose();
		} catch {
			// Best effort.
		}
		this.palette?.dispose();
		this.modelPicker?.dispose();
		this.sessionSwitcher?.dispose();
		this.diffViewer?.dispose();
		this.queueManager?.dispose();
		this.permissionSheet?.dispose();
		this.keymap.dispose();
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
		const models = await this.options.engine.listModels();
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
		this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
		this.shell.setHeader({ sessionID: shortSessionId(session.id) });
		this.transcript.clear();
		this.transcript.addNotice(`session ${shortSessionId(session.id)}`, "info");
		const messages = await session.messages().catch(() => []);
		for (const message of messages) {
			if (message.role === "user") this.transcript.addUser(message.text);
			else if (message.role === "assistant") this.transcript.addAssistant(message.text);
		}
		await this.refreshFooter();
	}

	private handleEvent(event: IoEvent): void {
		this.transcript.apply(event);
		if (event.type === "turn_started") {
			this.shell.setFooter({ mode: "generating" });
			return;
		}
		if (event.type === "turn_ended") {
			this.shell.setFooter({ mode: event.outcome === "succeeded" ? "ready" : event.outcome });
			if (event.outcome === "failed") this.toast(event.error ?? "turn failed", "error");
			void this.refreshFooter();
			void this.tabs.refresh(this.session?.id);
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
			this.toast(event.message, "error");
		}
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
		this.keymap.setSuspended(true);
		this.permissionSheet.open(request);
	}

	private async runCommand(text: string): Promise<void> {
		const [command = ""] = text.split(/\s+/);
		switch (command) {
			case "/help":
				this.transcript.addNotice(HELP, "info");
				return;
			case "/model":
				await this.openModels();
				return;
			case "/sessions":
			case "/resume":
				await this.openSessions();
				return;
			case "/new":
				await this.newSession();
				return;
			case "/compact":
				await this.compact();
				return;
			case "/diff":
				await this.openDiff();
				return;
			case "/queue":
				this.openQueue();
				return;
			case "/quit":
				await this.shutdown(0);
				return;
			default:
				this.transcript.addNotice(`unknown command: ${command}. Type /help.`, "warning");
		}
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
		const session = await this.options.engine.createSession({
			directory: this.options.cwd,
			model,
		});
		await this.attachSession(session);
		await this.refreshSessions();
		this.toast("new session", "success");
	}

	private async compact(): Promise<void> {
		if (!this.session) return;
		await this.session.compact();
		this.toast("compaction queued", "info");
	}

	private async openModels(): Promise<void> {
		const models = await this.options.engine.listModels();
		const current = this.session?.model;
		this.modelPicker?.dispose();
		this.modelPicker = new IoModelPicker({
			renderer: this.options.renderer,
			shell: this.shell,
			models,
			current,
			onSelect: async (model, variant) => {
				await this.session?.setModel({ provider: model.provider, id: model.id, ...(variant ? { variant } : {}) });
				await this.refreshFooter();
			},
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.keymap.setSuspended(true);
		this.modelPicker.open();
	}

	private async openSessions(): Promise<void> {
		this.sessionList = await this.options.engine.listSessions();
		this.sessionSwitcher?.dispose();
		this.sessionSwitcher = new IoSessionSwitcher({
			renderer: this.options.renderer,
			shell: this.shell,
			sessions: this.sessionList,
			activeID: this.session?.id,
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
		this.keymap.setSuspended(true);
		this.sessionSwitcher.open();
	}

	private async openDiff(): Promise<void> {
		this.diffViewer?.dispose();
		this.diffViewer = new IoDiffViewer({
			renderer: this.options.renderer,
			shell: this.shell,
			cwd: this.options.cwd,
			onClose: () => this.resumeUi(),
			onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
		});
		this.keymap.setSuspended(true);
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
		this.keymap.setSuspended(true);
		this.queueManager.open();
	}

	private openPalette(): void {
		if (!this.palette) {
			this.palette = new IoCommandPalette({
				renderer: this.options.renderer,
				shell: this.shell,
				commands: this.commands,
				onClose: () => this.resumeUi(),
				onError: (error) => this.toast(String((error as Error).message ?? error), "error"),
			});
		}
		this.keymap.setSuspended(true);
		this.palette.open();
	}

	private resumeUi(): void {
		this.keymap.setSuspended(false);
		this.composer.textarea.focus();
		this.shell.focusComposer();
	}

	private closeTransientOverlays(): void {
		this.palette?.close();
		this.modelPicker?.close();
		this.sessionSwitcher?.close();
		this.diffViewer?.close();
		this.queueManager?.close();
	}

	private async refreshSessions(): Promise<void> {
		this.sessionList = await this.options.engine.listSessions();
		this.tabs.setSessions(this.sessionList, this.session?.id);
	}

	private async refreshFooter(): Promise<void> {
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
			model: model ? `${model.provider}/${model.id}${model.variant ? ` (${model.variant})` : ""}` : undefined,
			context,
			tokens,
			cost,
			queue: this.composer.queued.length,
		});
		this.shell.setHeader({ cwd: this.options.cwd, branch });
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

	private switchTheme(): void {
		const index = THEMES.indexOf(this.appearance.themePreference);
		const next = THEMES[(index + 1) % THEMES.length] ?? "io";
		this.appearance.setTheme(next);
		this.appearance.applyToShell(this.shell);
		this.toast(`theme: ${next}`, "info");
	}

	private toast(message: string, kind: "info" | "success" | "warning" | "error" | "permission"): void {
		this.shell.toast(message, kind);
	}

	private commandHandlers(): Partial<Record<string, () => void | Promise<void>>> {
		return {
			"command.palette.show": () => this.openPalette(),
			"model.list": () => this.openModels(),
			"model.variant.cycle": () => this.openModels(),
			"session.list": () => this.openSessions(),
			"session.new": () => this.newSession(),
			"session.compact": () => this.compact(),
			"session.interrupt": () => this.session?.abort(),
			"prompt.queue": () => {
				this.composer.submit("queue");
			},
			"queued.prompts": () => this.openQueue(),
			"diff.open": () => this.openDiff(),
			"tool.output.toggle": () => this.toggleToolOutput(),
			"thinking.toggle": () => this.toggleThinking(),
			"verbosity.cycle": () => this.cycleVerbosity(),
			"tps.toggle": () => this.toggleTps(),
			"theme.switch": () => this.switchTheme(),
			"which-key.toggle": () => this.keymap.showAllBindings(),
			"app.exit": () => this.shutdown(0),
		};
	}
}


export interface IoNextAppFromPathsOptions {
	cwd: string;
	paths: IoPaths;
	renderer: CliRenderer;
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
}

/** Build the embedded OpenCode engine with io's shell and storage. */
export async function createIoEngine(options: IoEngineFromPathsOptions): Promise<AgentEngine> {
	ensureIoDirectories(options.paths);
	const models = syncModelsConfig(options.paths);
	for (const warning of models.warnings) process.stderr.write(`io: ${warning}\n`);
	return OpenCodeEngine.create({
		cwd: options.cwd,
		configDir: join(options.paths.configDir, "opencode"),
		databasePath: join(options.paths.dataDir, "opencode.db"),
		plugins: [createIoSecurityPlugin({ cwd: options.cwd, envNames: options.envNames })],
	});
}

/** Production entrypoint: build the embedded OpenCode engine with io's shell tool. */
export async function createIoNextApp(options: IoNextAppFromPathsOptions): Promise<IoNextApp> {
	const engine = await createIoEngine(options);
	return IoNextApp.create({
		cwd: options.cwd,
		renderer: options.renderer,
		engine,
		appearance: options.appearance,
		sessionID: options.sessionID,
		model: options.model,
		envNames: options.envNames,
		onExit: options.onExit,
	});
}
