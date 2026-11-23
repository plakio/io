import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { OpenCode } from "@opencode/sdk";
import type {
	AgentEngine,
	EngineMessage,
	EngineMessageRole,
	EngineModel,
	EngineModelRef,
	EnginePermissionRequest,
	EnginePermissionRule,
	EnginePromptOptions,
	EngineSession,
	EngineSessionListOptions,
	EngineSessionOptions,
	EngineSessionSummary,
	EngineStats,
	EngineTokenUsage,
	IoEvent,
	PermissionDecision,
} from "./types.js";
import { VERSION } from "../version.js";

type OpenCodeHost = Awaited<ReturnType<typeof OpenCode.create>>;
type EventEnvelope = { type: string; data?: Record<string, unknown> };

export interface OpenCodeEngineOptions {
	cwd: string;
	configDir: string;
	databasePath: string;
	/** Plugins registered on the embedded host, for example a custom provider. */
	plugins?: readonly unknown[];
	/** Fetch models.dev on startup. Off by default to keep tests offline. */
	fetchModels?: boolean;
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tokenUsage(raw: unknown): EngineTokenUsage {
	const value = (raw ?? {}) as {
		input?: unknown;
		output?: unknown;
		reasoning?: unknown;
		cache?: { read?: unknown; write?: unknown };
	};
	return {
		input: number(value.input),
		output: number(value.output),
		reasoning: number(value.reasoning),
		cacheRead: number(value.cache?.read),
		cacheWrite: number(value.cache?.write),
	};
}

function errorMessage(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.message === "string") return record.message;
		if (typeof record.type === "string") return record.type;
	}
	return "unknown error";
}

function modelOf(raw: unknown): EngineModel | undefined {
	const value = raw as {
		id?: unknown;
		modelID?: unknown;
		providerID?: unknown;
		name?: unknown;
		limit?: { context?: unknown; output?: unknown };
		capabilities?: { input?: unknown; output?: unknown };
		variants?: Array<{ id?: unknown }>;
		cost?: Array<{
			tier?: { type?: unknown; size?: unknown };
			input?: unknown;
			output?: unknown;
			cache?: { read?: unknown; write?: unknown };
		}>;
	};
	const id = typeof value.modelID === "string" ? value.modelID : typeof value.id === "string" ? value.id : "";
	const provider = typeof value.providerID === "string" ? value.providerID : "";
	if (!id || !provider) return undefined;
	const variants = Array.isArray(value.variants)
		? value.variants
				.map((variant) => (typeof variant?.id === "string" ? variant.id : ""))
				.filter((variant) => variant.length > 0)
		: [];
	return {
		provider,
		id,
		name: typeof value.name === "string" ? value.name : id,
		contextWindow: number(value.limit?.context),
		maxTokens: number(value.limit?.output),
		reasoning: variants.length > 0,
		variants,
		input: Array.isArray(value.capabilities?.input)
			? value.capabilities.input.filter((entry): entry is string => typeof entry === "string")
			: [],
		output: Array.isArray(value.capabilities?.output)
			? value.capabilities.output.filter((entry): entry is string => typeof entry === "string")
			: [],
		cost: Array.isArray(value.cost)
			? (() => {
					const tier = value.cost.find((entry) => entry.tier?.type !== "context") ?? value.cost[0];
					return tier
						? {
								input: number(tier.input),
								output: number(tier.output),
								cacheRead: number(tier.cache?.read),
								cacheWrite: number(tier.cache?.write),
							}
						: undefined;
				})()
			: undefined,
	};
}

function messageRole(type: string): EngineMessageRole {
	if (type === "user") return "user";
	if (type === "assistant") return "assistant";
	if (type === "system") return "system";
	if (type === "shell") return "tool";
	return "other";
}

function messageText(raw: unknown): string {
	const value = raw as { text?: unknown; content?: unknown };
	if (typeof value.text === "string") return value.text;
	if (!Array.isArray(value.content)) return "";
	return value.content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const content = part as { type?: unknown; text?: unknown };
			if (content.type === "text" && typeof content.text === "string") return content.text;
			if (content.type === "tool" && typeof content.text === "string") return content.text;
			return "";
		})
		.filter((part) => part.length > 0)
		.join("");
}

export class OpenCodeEngine implements AgentEngine {
	readonly kind = "opencode" as const;
	private readonly host: OpenCodeHost;
	private readonly cwd: string;
	private readonly models = new Map<string, EngineModel>();
	private readonly sessions = new Set<OpenCodeSession>();

	private constructor(host: OpenCodeHost, cwd: string) {
		this.host = host;
		this.cwd = cwd;
	}

	static async create(options: OpenCodeEngineOptions): Promise<OpenCodeEngine> {
		mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
		mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
		const host = await OpenCode.create({
			app: { name: "io", version: VERSION },
			database: { path: options.databasePath },
			config: { directory: options.configDir, project: false, claude: false },
			models: { fetch: options.fetchModels === true },
			plugins: options.plugins as never,
			log: { level: "error" },
		});
		return new OpenCodeEngine(host, options.cwd);
	}

	async listModels(): Promise<readonly EngineModel[]> {
		const result = await this.host.model.list({ location: { directory: this.cwd } });
		const data = (result as { data?: unknown[] }).data ?? [];
		const models = data.map(modelOf).filter((model): model is EngineModel => model !== undefined);
		this.models.clear();
		for (const model of models) this.models.set(`${model.provider}/${model.id}`, model);
		return models;
	}

	async findModel(reference: EngineModelRef): Promise<EngineModel | undefined> {
		const key = `${reference.provider}/${reference.id}`;
		return this.models.get(key) ?? (await this.listModels()).find((model) => `${model.provider}/${model.id}` === key);
	}

	async createSession(options: EngineSessionOptions): Promise<EngineSession> {
		const info = await this.host.sessions.create({
			location: { directory: options.directory || this.cwd },
		});
		if (options.permissions && options.permissions.length > 0) {
			await this.host.sessions.update({
				sessionID: info.id,
				permissions: options.permissions,
			});
		}
		return this.wrap(info.id, options.model);
	}

	async resumeSession(sessionID: string): Promise<EngineSession> {
		const info = await this.host.sessions.get({ sessionID });
		const model =
			info.model && typeof info.model.providerID === "string" && typeof info.model.id === "string"
				? {
						provider: info.model.providerID,
						id: info.model.id,
						...(typeof info.model.variant === "string" ? { variant: info.model.variant } : {}),
					}
				: undefined;
		return this.wrap(info.id, model);
	}

	async listSessions(options: EngineSessionListOptions = {}): Promise<readonly EngineSessionSummary[]> {
		const result = await this.host.sessions.list({
			directory: options.directory ?? this.cwd,
			limit: options.limit ?? 50,
			...(options.search ? { search: options.search } : {}),
			parentID: null,
		});
		const data = (result as { data?: unknown[] }).data ?? [];
		return data
			.map((raw): EngineSessionSummary | undefined => {
				const session = raw as {
					id?: unknown;
					title?: unknown;
					parentID?: unknown;
					time?: { created?: unknown; updated?: unknown };
					location?: { directory?: unknown };
				};
				if (typeof session.id !== "string") return undefined;
				return {
					id: session.id,
					title: typeof session.title === "string" && session.title.length > 0 ? session.title : "(untitled)",
					parentID: typeof session.parentID === "string" ? session.parentID : undefined,
					createdAt: number(session.time?.created),
					updatedAt: number(session.time?.updated),
					directory: typeof session.location?.directory === "string" ? session.location.directory : undefined,
				};
			})
			.filter((session): session is EngineSessionSummary => session !== undefined && !session.parentID);
	}

	async renameSession(sessionID: string, title: string): Promise<void> {
		await this.host.sessions.update({ sessionID, title });
	}

	async deleteSession(sessionID: string): Promise<void> {
		await this.host.sessions.remove({ sessionID });
	}

	async close(): Promise<void> {
		for (const session of this.sessions) await session.dispose();
		this.sessions.clear();
		await this.host.close();
	}

	private async wrap(sessionID: string, model?: EngineModelRef): Promise<OpenCodeSession> {
		const session = new OpenCodeSession(this, this.host, sessionID, model);
		this.sessions.add(session);
		if (model) await session.setModel(model);
		return session;
	}

	/** @internal used by forked sessions. */
	async wrapFork(sessionID: string): Promise<EngineSession> {
		return this.wrap(sessionID);
	}

	/** @internal used by sessions for cleanup. */
	removeSession(session: OpenCodeSession): void {
		this.sessions.delete(session);
	}
}

export class OpenCodeSession implements EngineSession {
	private readonly engine: OpenCodeEngine;
	private readonly host: OpenCodeHost;
	readonly id: string;
	private currentModel: EngineModelRef | undefined;
	private modelInfo: EngineModel | undefined;
	private readonly listeners = new Set<(event: IoEvent) => void>();
	private readonly controller = new AbortController();
	private readonly toolNames = new Map<string, string>();
	private readonly pendingInbox = new Set<string>();
	private readonly pendingPermissions = new Map<string, EnginePermissionRequest>();
	private readonly settledWaiters = new Set<() => void>();
	private loop: Promise<void> | undefined;
	private iterator: AsyncIterator<unknown> | undefined;
	private busy = false;
	private disposed = false;
	private lastUsage: EngineTokenUsage | undefined;
	private lastCost = 0;

	constructor(engine: OpenCodeEngine, host: OpenCodeHost, sessionID: string, model?: EngineModelRef) {
		this.engine = engine;
		this.host = host;
		this.id = sessionID;
		this.currentModel = model;
		this.start();
	}

	get model(): EngineModelRef | undefined {
		return this.currentModel;
	}

	subscribe(listener: (event: IoEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string, options: EnginePromptOptions = {}): Promise<void> {
		const shouldWait = options.wait ?? !this.busy;
		let waiter: (() => void) | undefined;
		const settled = shouldWait
			? new Promise<void>((resolve) => {
					waiter = resolve;
					this.settledWaiters.add(resolve);
				})
			: undefined;
		try {
			await this.host.sessions.prompt({
				sessionID: this.id,
				text,
				...(options.delivery ? { delivery: options.delivery } : {}),
			});
			if (settled) await settled;
		} finally {
			if (waiter) this.settledWaiters.delete(waiter);
		}
	}

	async abort(): Promise<void> {
		await this.host.sessions.interrupt({ sessionID: this.id, resume: false });
	}

	async compact(): Promise<void> {
		await this.host.sessions.compact({ sessionID: this.id });
	}

	async fork(before?: string): Promise<EngineSession> {
		const info = await this.host.sessions.fork({ sessionID: this.id, ...(before ? { before } : {}) });
		return this.engine.wrapFork(info.id);
	}

	async setModel(model: EngineModelRef): Promise<void> {
		this.currentModel = model;
		this.modelInfo = await this.engine.findModel(model);
		await this.host.sessions.switchModel({
			sessionID: this.id,
			model: {
				providerID: model.provider,
				id: model.id,
				...(model.variant ? { variant: model.variant } : {}),
			},
		});
	}

	async respondPermission(
		requestID: string,
		decision: PermissionDecision,
		message?: string,
	): Promise<void> {
		await this.host.permission.reply({
			sessionID: this.id,
			requestID,
			decision,
			...(message ? { message } : {}),
		});
		this.pendingPermissions.delete(requestID);
	}

	async setPermissions(permissions: readonly EnginePermissionRule[]): Promise<void> {
		await this.host.sessions.update({ sessionID: this.id, permissions });
	}

	async stats(): Promise<EngineStats> {
		const info = await this.host.sessions.get({ sessionID: this.id });
		const reported = tokenUsage(info.tokens);
		const tokens =
			reported.input === 0 && reported.output === 0 && this.lastUsage ? this.lastUsage : reported;
		const contextUsed = tokens.input + tokens.cacheRead + tokens.cacheWrite;
		const contextWindow = this.modelInfo?.contextWindow ?? null;
		const model = info.model
			? {
					provider: String(info.model.providerID),
					id: String(info.model.id),
					...(typeof info.model.variant === "string" ? { variant: info.model.variant } : {}),
				}
			: this.currentModel;
		return {
			sessionID: this.id,
			model,
			tokens,
			cost: number(info.cost) || this.lastCost,
			contextUsed: contextWindow && contextWindow > 0 ? contextUsed : null,
			contextWindow: contextWindow && contextWindow > 0 ? contextWindow : null,
			contextPercent:
				contextWindow && contextWindow > 0 ? Math.min(100, (contextUsed / contextWindow) * 100) : null,
		};
	}

	async messages(): Promise<readonly EngineMessage[]> {
		const context = await this.host.sessions.context({ sessionID: this.id });
		return (context as unknown[]).map((raw) => {
			const message = (raw ?? {}) as {
				id?: unknown;
				type?: unknown;
				time?: { created?: unknown };
				text?: unknown;
				content?: unknown;
			};
			return {
				id: String(message.id ?? ""),
				role: messageRole(String(message.type ?? "")),
				text: messageText(message),
				createdAt: number(message.time?.created),
			};
		});
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.controller.abort();
		this.listeners.clear();
		this.settledWaiters.clear();
		await this.iterator?.return?.();
		this.iterator = undefined;
		await this.loop?.catch(() => undefined);
		this.engine.removeSession(this);
	}

	private start(): void {
		this.loop = (async () => {
			while (!this.controller.signal.aborted) {
				try {
					this.emit({ type: "connected" });
					const iterator = this.host.events
						.subscribe(undefined, { signal: this.controller.signal })
						[Symbol.asyncIterator]();
					this.iterator = iterator as AsyncIterator<unknown>;
					while (!this.controller.signal.aborted) {
						const next = await this.iterator.next();
						if (next.done || this.disposed) return;
						this.handleEvent(next.value as EventEnvelope);
					}
				} catch (error) {
					if (this.controller.signal.aborted) return;
					this.emit({ type: "error", sessionID: this.id, message: errorMessage(error) });
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			}
		})();
	}

	private emit(event: IoEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// A broken listener must not stop the event pump.
			}
		}
	}

	private settle(): void {
		this.busy = false;
		for (const waiter of this.settledWaiters) waiter();
		this.settledWaiters.clear();
	}

	private handleEvent(event: EventEnvelope): void {
		const data = event.data ?? {};
		if (data.sessionID !== this.id) return;
		const messageID = String(data.assistantMessageID ?? "");
		switch (event.type) {
			case "session.execution.started":
				this.busy = true;
				this.emit({ type: "turn_started", sessionID: this.id });
				return;
			case "session.execution.succeeded":
				this.settle();
				this.emit({ type: "turn_ended", sessionID: this.id, outcome: "succeeded" });
				return;
			case "session.execution.failed":
				this.settle();
				this.emit({
					type: "turn_ended",
					sessionID: this.id,
					outcome: "failed",
					error: errorMessage(data.error),
				});
				return;
			case "session.execution.interrupted":
				this.settle();
				this.emit({
					type: "turn_ended",
					sessionID: this.id,
					outcome: "interrupted",
					error: typeof data.reason === "string" ? data.reason : undefined,
				});
				return;
			case "session.text.started":
				this.emit({ type: "text_started", sessionID: this.id, messageID });
				return;
			case "session.text.delta":
				this.emit({
					type: "text_delta",
					sessionID: this.id,
					messageID,
					delta: typeof data.delta === "string" ? data.delta : "",
				});
				return;
			case "session.text.ended":
				this.emit({ type: "text_ended", sessionID: this.id, messageID });
				return;
			case "session.reasoning.started":
				this.emit({ type: "reasoning_started", sessionID: this.id, messageID });
				return;
			case "session.reasoning.delta":
				this.emit({
					type: "reasoning_delta",
					sessionID: this.id,
					messageID,
					delta: typeof data.delta === "string" ? data.delta : "",
				});
				return;
			case "session.reasoning.ended":
				this.emit({ type: "reasoning_ended", sessionID: this.id, messageID });
				return;
			case "session.tool.input.started": {
				const toolCallID = String(data.id ?? "");
				const name = typeof data.name === "string" ? data.name : "tool";
				this.toolNames.set(toolCallID, name);
				this.emit({ type: "tool_started", sessionID: this.id, toolCallID, name });
				return;
			}
			case "session.tool.input.delta":
				this.emit({
					type: "tool_updated",
					sessionID: this.id,
					toolCallID: String(data.id ?? ""),
					name: this.toolNames.get(String(data.id ?? "")),
					delta: typeof data.delta === "string" ? data.delta : "",
				});
				return;
			case "session.tool.input.ended":
				this.emit({
					type: "tool_updated",
					sessionID: this.id,
					toolCallID: String(data.id ?? ""),
					name: this.toolNames.get(String(data.id ?? "")),
					delta: typeof data.text === "string" ? data.text : "",
				});
				return;
			case "session.tool.called":
				this.emit({
					type: "tool_called",
					sessionID: this.id,
					toolCallID: String(data.id ?? ""),
					name: this.toolNames.get(String(data.id ?? "")),
					input: data.input,
					executed: data.executed === true,
				});
				return;
			case "session.tool.progress":
				this.emit({
					type: "tool_progress",
					sessionID: this.id,
					toolCallID: String(data.id ?? ""),
					metadata: data.metadata,
				});
				return;
			case "session.tool.success": {
				const toolCallID = String(data.id ?? "");
				this.emit({
					type: "tool_finished",
					sessionID: this.id,
					toolCallID,
					name: this.toolNames.get(toolCallID),
					status: "success",
					content: data.content,
					metadata: data.metadata,
				});
				this.toolNames.delete(toolCallID);
				return;
			}
			case "session.tool.failed": {
				const toolCallID = String(data.id ?? "");
				this.emit({
					type: "tool_finished",
					sessionID: this.id,
					toolCallID,
					name: this.toolNames.get(toolCallID),
					status: "error",
					content: data.content,
					error: errorMessage(data.error),
					metadata: data.metadata,
				});
				this.toolNames.delete(toolCallID);
				return;
			}
			case "permission.asked": {
				const request: EnginePermissionRequest = {
					requestID: String(data.id ?? ""),
					sessionID: this.id,
					action: String(data.action ?? "unknown"),
					resources: Array.isArray(data.resources)
						? data.resources.filter((resource): resource is string => typeof resource === "string")
						: [],
					save: Array.isArray(data.save)
						? data.save.filter((resource): resource is string => typeof resource === "string")
						: undefined,
					message: typeof data.message === "string" ? data.message : undefined,
					metadata: data.metadata,
					source: data.source,
				};
				this.pendingPermissions.set(request.requestID, request);
				this.emit({ type: "permission_requested", sessionID: this.id, request });
				return;
			}
			case "permission.replied": {
				const requestID = String(data.requestID ?? "");
				const decision = data.reply === "always" || data.reply === "reject" ? data.reply : "once";
				this.pendingPermissions.delete(requestID);
				this.emit({ type: "permission_resolved", sessionID: this.id, requestID, decision });
				return;
			}
			case "session.compaction.started":
				this.emit({
					type: "compaction_started",
					sessionID: this.id,
					reason: data.reason === "manual" ? "manual" : "auto",
				});
				return;
			case "session.compaction.ended":
				this.emit({
					type: "compaction_ended",
					sessionID: this.id,
					reason: data.reason === "manual" ? "manual" : "auto",
					text: typeof data.text === "string" ? data.text : undefined,
					tokens: data.tokens ? tokenUsage(data.tokens) : undefined,
				});
				return;
			case "session.compaction.failed":
				this.emit({
					type: "compaction_failed",
					sessionID: this.id,
					reason: data.reason === "manual" ? "manual" : "auto",
					error: errorMessage(data.error),
				});
				return;
			case "session.retry.scheduled":
				this.emit({
					type: "retry_scheduled",
					sessionID: this.id,
					attempt: number(data.attempt),
					at: number(data.at),
					error: errorMessage(data.error),
				});
				return;
			case "session.inbox.enqueued":
				this.pendingInbox.add(String(data.inboxID ?? ""));
				this.emit({ type: "queue_changed", sessionID: this.id, pending: this.pendingInbox.size });
				return;
			case "session.inbox.delivered":
			case "session.inbox.cancelled":
				this.pendingInbox.delete(String(data.inboxID ?? ""));
				this.emit({ type: "queue_changed", sessionID: this.id, pending: this.pendingInbox.size });
				return;
			case "session.usage.updated":
				this.lastUsage = tokenUsage(data.tokens);
				this.lastCost = number(data.cost);
				this.emit({
					type: "usage_updated",
					sessionID: this.id,
					tokens: this.lastUsage,
					cost: this.lastCost,
				});
				return;
			case "session.idle":
				this.settle();
				this.emit({ type: "idle", sessionID: this.id });
				return;
			default:
				return;
		}
	}
}
