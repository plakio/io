import type { Api, Model } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	createAgentSession,
	createBashToolDefinition,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ModelRuntime,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { IoPaths, PermissionMode, ThinkingLevel } from "./config.js";
import { loadConfig, resolvePermissionMode } from "./config.js";
import { DEFAULT_AGENTS, getAgent, canDelegate, type AgentCatalog, type AgentDefinition } from "./agents.js";
import { decideShellPermission, sanitizeBashEnvironment } from "./safety.js";
import { readProviderEnvNames } from "./runtime.js";
import { buildIoSystemPrompt } from "./system-prompt.js";
import { createSubagentTool } from "./subagent-tool.js";
import { VERSION } from "./version.js";

export interface SessionFile {
	path: string;
	id: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	name?: string;
}

export async function listSessions(paths: IoPaths, cwd: string): Promise<SessionFile[]> {
	const sessions = await SessionManager.list(cwd, paths.sessionsDir);
	return sessions.map((session) => ({
		path: session.path,
		id: session.id,
		created: session.created,
		modified: session.modified,
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
		name: session.name,
	}));
}

export async function findSessionByPrefix(
	paths: IoPaths,
	cwd: string,
	prefix: string,
): Promise<{ session?: SessionFile; error?: string }> {
	const sessions = await listSessions(paths, cwd);
	const exact = sessions.find((session) => session.id === prefix);
	if (exact) return { session: exact };
	const matches = sessions.filter((session) => session.id.startsWith(prefix));
	if (matches.length === 0) {
		return { error: `No session found with id starting "${prefix}" in ${cwd}.` };
	}
	const first = matches[0];
	if (!first) return { error: `No session found with id starting "${prefix}".` };
	if (matches.length > 1) {
		return {
			error: `Session id "${prefix}" is ambiguous (${matches.length} matches). Use a longer prefix.`,
		};
	}
	return { session: first };
}

export async function resolveSessionManager(
	paths: IoPaths,
	cwd: string,
	options: { continueSession?: boolean; sessionId?: string },
): Promise<{ manager: SessionManager; resumed: boolean; session?: SessionFile; error?: string }> {
	if (options.sessionId) {
		const found = await findSessionByPrefix(paths, cwd, options.sessionId);
		if (!found.session) return { manager: SessionManager.inMemory(cwd), resumed: false, error: found.error };
		return {
			manager: SessionManager.open(found.session.path, paths.sessionsDir),
			resumed: true,
			session: found.session,
		};
	}
	if (options.continueSession) {
		return {
			manager: SessionManager.continueRecent(cwd, paths.sessionsDir),
			resumed: true,
		};
	}
	return {
		manager: SessionManager.create(cwd, paths.sessionsDir),
		resumed: false,
	};
}

export interface ConfirmCommandRequest {
	command: string;
	reason: string;
	signal?: AbortSignal;
}

export type ConfirmCommand = (request: ConfirmCommandRequest) => Promise<boolean>;

export interface HarnessOptions {
	cwd: string;
	paths: IoPaths;
	modelRuntime: ModelRuntime;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	sessionManager?: SessionManager;
	continueSession?: boolean;
	sessionId?: string;
	settingsManager?: SettingsManager;
	confirmCommand?: ConfirmCommand;
	/**
	 * Overrides the configured permission mode. Read-only agents force `ask`
	 * so `auto` in the config cannot unlock destructive commands for them.
	 */
	permissionMode?: PermissionMode;
	/** UI channel for permission events that have no prompt (denials, blocked subagents). */
	notify?: (message: string) => void;
	systemPrompt?: string;
	tools?: ToolDefinition[];
	agent?: AgentDefinition;
	agentCatalog?: AgentCatalog;
	/** Project context. Omitted fields are disabled; `main.ts` resolves config defaults. */
	context?: { skills?: boolean; contextFiles?: boolean };
}

export interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	resumed: boolean;
	sessionFile?: SessionFile;
	modelFallbackMessage?: string;
	/** Tool definitions, so the TUI can reuse Pi's renderers. */
	tools: ToolDefinition<any, any, any>[];
	agent: AgentDefinition;
	agentCatalog: AgentCatalog;
	/** Resolved context flags, preserved when the harness is replaced (/new, /resume, /fork). */
	context: { skills: boolean; contextFiles: boolean };
	/** Permission mode override and notice channel, preserved across harness replacement. */
	permissionMode?: PermissionMode;
	notify?: (message: string) => void;
}

export interface ReplaceHarnessOptions {
	cwd: string;
	paths: IoPaths;
	modelRuntime: ModelRuntime;
	confirmCommand?: ConfirmCommand;
	permissionMode?: PermissionMode;
	notify?: (message: string) => void;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	continueSession?: boolean;
	sessionId?: string;
}

export interface SessionReplacement {
	harness: Harness;
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
}

/**
 * Create a fresh harness for a new or resumed session. Used by /new, /resume,
 * and /fork. The caller must dispose the old harness after switching.
 */
export async function replaceHarnessSession(
	current: Harness,
	options: ReplaceHarnessOptions,
): Promise<SessionReplacement> {
	const model = options.model ?? current.session.model;
	const thinkingLevel = options.thinkingLevel ?? current.session.thinkingLevel;

	const harness = await createHarness({
		cwd: options.cwd,
		paths: options.paths,
		modelRuntime: options.modelRuntime,
		model: model as Model<Api>,
		thinkingLevel,
		confirmCommand: options.confirmCommand,
		permissionMode: options.permissionMode ?? current.permissionMode,
		notify: options.notify ?? current.notify,
		continueSession: options.continueSession,
		sessionId: options.sessionId,
		agentCatalog: current.agentCatalog,
		context: current.context,
	});

	return { harness, model, thinkingLevel };
}

function discoverSkillDirectories(cwd: string): string[] {
	const candidates = [join(homedir(), ".agents", "skills")];
	// Walk up so running from a subdirectory still finds the repo's skills.
	let current = cwd;
	while (true) {
		candidates.push(join(current, ".agents", "skills"));
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	const seen = new Set<string>();
	return candidates.filter((directory) => {
		if (seen.has(directory)) return false;
		seen.add(directory);
		return existsSync(directory);
	});
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
	const resolved = options.sessionManager
		? {
				manager: options.sessionManager,
				resumed: options.continueSession === true || options.sessionId !== undefined,
				session: undefined,
				error: undefined,
			}
		: await resolveSessionManager(options.paths, options.cwd, {
				continueSession: options.continueSession,
				sessionId: options.sessionId,
			});
	if (resolved.error) {
		throw new Error(resolved.error);
	}
	const hadExistingMessages = resolved.manager.buildSessionContext().messages.length > 0;

	const settingsManager = options.settingsManager ?? SettingsManager.inMemory();
	const contextOptions = options.context ?? {};
	const skills = contextOptions.skills === true;
	const contextFiles = contextOptions.contextFiles === true;
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.paths.dataDir,
		settingsManager,
		noExtensions: true,
		// Pi's defaults only look at `.pi/skills`; io loads the user's Claude-style
		// `~/.agents/skills` and the project's `.agents/skills` instead.
		noSkills: true,
		additionalSkillPaths: skills ? discoverSkillDirectories(options.cwd) : undefined,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: !contextFiles,
		systemPrompt: options.systemPrompt ?? buildIoSystemPrompt(),
	});
	await resourceLoader.reload();

	const providerEnvNames = readProviderEnvNames(options.paths.modelsPath);
	const bashTool = createBashToolDefinition(options.cwd, {
		spawnHook: (context) => ({
			...context,
			env: sanitizeBashEnvironment(context.env, providerEnvNames),
		}),
	});

	const catalog = options.agentCatalog ?? DEFAULT_AGENTS;
	const agent = options.agent ?? getAgent(catalog, catalog.primary) ?? getAgent(catalog, "build") ?? DEFAULT_AGENTS.agents[0]!;
	const extraTools: ToolDefinition[] = [...(options.tools ?? [])];
	if (canDelegate(agent)) {
		extraTools.push(
			createSubagentTool({
				cwd: options.cwd,
				paths: options.paths,
				modelRuntime: options.modelRuntime,
				currentModel: options.model,
				catalog,
				confirmCommand: options.confirmCommand,
				notify: options.notify,
			}) as unknown as ToolDefinition,
		);
	}

	const customTools = [bashTool, ...extraTools] as unknown as ToolDefinition[];
	const created = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.paths.dataDir,
		modelRuntime: options.modelRuntime,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		resourceLoader,
		sessionManager: resolved.manager,
		settingsManager,
		tools: ["bash"],
		customTools,
	});

	const session = created.session;
	session.agent.toolExecution = "sequential";
	session.agent.identity = {
		userAgent: { custom: `io/${VERSION} (${process.platform}; node/${process.version})` },
		version: VERSION,
		attribution: null,
	};

	const confirmCommand = options.confirmCommand;
	const notify = options.notify;
	session.agent.beforeToolCall = async (context, signal) => {
		if (context.toolCall.name !== "bash") return undefined;
		const command = (context.args as { command?: unknown }).command;
		if (typeof command !== "string") return undefined;
		// Read permissions fresh from disk on every check, so an "allow always"
		// saved by the TUI (or a `/mode` switch, or an external edit) applies to
		// THIS session now.
		const config = loadConfig(options.paths).config;
		const rules = config.permissions ?? [];
		const mode = options.permissionMode ?? resolvePermissionMode(config);
		const decision = decideShellPermission(rules, command, mode);
		if (decision.decision === "deny") {
			return {
				block: true,
				reason: `Blocked by io permissions (${decision.reason ?? "deny rule"}): ${command}`,
			};
		}
		if (decision.decision === "allow") return undefined;
		if (!confirmCommand) {
			// No TUI to ask: say so out loud instead of denying invisibly.
			notify?.(`blocked without approval channel: ${command} (${decision.reason ?? "destructive command"})`);
			return {
				block: true,
				reason: `Blocked: this session has no way to ask the user for approval, so "${command}" was not run. Report this to the user and ask them to run it themselves or suggest a safer command.`,
			};
		}
		const allowed = await confirmCommand({ command, reason: decision.reason ?? "destructive command", signal });
		if (!allowed || signal?.aborted) {
			return {
				block: true,
				reason: "The user denied permission to run this command. Ask before retrying or choose a safer approach.",
			};
		}
		return undefined;
	};

	return {
		session,
		sessionManager: resolved.manager,
		settingsManager,
		resumed: options.sessionId !== undefined || (options.continueSession === true && hadExistingMessages),
		sessionFile: resolved.session,
		modelFallbackMessage: created.modelFallbackMessage,
		tools: customTools,
		agent,
		agentCatalog: catalog,
		context: { skills, contextFiles },
		permissionMode: options.permissionMode,
		notify: options.notify,
	};
}
