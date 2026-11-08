import type { Api, Model } from "@earendil-works/pi-ai";
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
import type { IoPaths, ThinkingLevel } from "./config.js";
import { assessCommand, sanitizeBashEnvironment } from "./safety.js";
import { buildIoSystemPrompt } from "./system-prompt.js";
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
	systemPrompt?: string;
}

export interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	resumed: boolean;
	sessionFile?: SessionFile;
	modelFallbackMessage?: string;
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
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.paths.dataDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: options.systemPrompt ?? buildIoSystemPrompt(),
	});
	await resourceLoader.reload();

	const bashTool = createBashToolDefinition(options.cwd, {
		spawnHook: (context) => ({
			...context,
			env: sanitizeBashEnvironment(context.env),
		}),
	});

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
		customTools: [bashTool] as unknown as ToolDefinition[],
	});

	const session = created.session;
	session.agent.toolExecution = "sequential";
	session.agent.identity = {
		userAgent: { custom: `io/${VERSION} (${process.platform}; node/${process.version})` },
		version: VERSION,
		attribution: null,
	};

	const confirmCommand = options.confirmCommand;
	session.agent.beforeToolCall = async (context, signal) => {
		if (context.toolCall.name !== "bash") return undefined;
		const command = (context.args as { command?: unknown }).command;
		if (typeof command !== "string") return undefined;
		const risk = assessCommand(command);
		if (!risk.dangerous) return undefined;
		const allowed = confirmCommand
			? await confirmCommand({ command, reason: risk.reason ?? "destructive command", signal })
			: false;
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
	};
}
