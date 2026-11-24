/** Engine-agnostic contracts used by the io TUI. */
export type EngineKind = "opencode" | "pi";

export interface EngineModelRef {
	provider: string;
	id: string;
	variant?: string;
}

export interface EngineModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface EngineModel extends EngineModelRef {
	name: string;
	contextWindow: number;
	maxTokens: number;
	/** Whether the model exposes reasoning variants. */
	reasoning: boolean;
	variants: readonly string[];
	input: readonly string[];
	output: readonly string[];
	cost?: EngineModelCost;
}

export interface EngineTokenUsage {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface EngineStats {
	sessionID: string;
	model?: EngineModelRef;
	tokens: EngineTokenUsage;
	cost: number;
	contextUsed: number | null;
	contextWindow: number | null;
	contextPercent: number | null;
}

export type EngineMessageRole = "user" | "assistant" | "system" | "tool" | "other";

export interface EngineMessage {
	id: string;
	role: EngineMessageRole;
	text: string;
	createdAt: number;
}

export type PermissionDecision = "once" | "always" | "reject";

export interface EnginePermissionRequest {
	requestID: string;
	sessionID: string;
	action: string;
	resources: readonly string[];
	save?: readonly string[];
	message?: string;
	metadata?: unknown;
	source?: unknown;
}

export interface EngineFileDiff {
	path: string;
	patch: string;
}

export interface EngineAgent {
	id: string;
	name: string;
	description?: string;
	mode: "primary" | "subagent" | "all";
	hidden: boolean;
	model?: EngineModelRef;
	color?: string;
	steps?: number;
}

export type EngineFormValue = string | number | boolean | string[];

export interface EngineFormOption {
	value: string;
	label: string;
	description?: string;
}

export interface EngineFormField {
	key: string;
	title?: string;
	description?: string;
	required?: boolean;
	hidden?: boolean;
	type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external";
	options?: readonly EngineFormOption[];
	default?: EngineFormValue;
	url?: string;
}

export interface EngineForm {
	id: string;
	sessionID: string;
	title: string;
	fields: readonly EngineFormField[];
}

export interface EngineCommand {
	name: string;
	description?: string;
}

export interface EngineSavedPermission {
	id: string;
	action: string;
	resource: string;
}

export interface EngineWorktree {
	directory: string;
	strategy?: string;
}

export interface EngineMcpServer {
	name: string;
	status: string;
	title?: string;
}

export interface EngineSkill {
	id: string;
	name: string;
	description?: string;
}

export interface EngineUsageMeter {
	percent: number;
	limited: boolean;
	resetsAt: number;
}

export interface EngineUsageBudget {
	id: string;
	limit: number;
	spent: number;
	resetsAt: number;
}

export interface EngineUsage {
	workspace: string;
	name?: string;
	url?: string;
	go?: { rolling: EngineUsageMeter; weekly: EngineUsageMeter; monthly: EngineUsageMeter };
	budgets: readonly EngineUsageBudget[];
}

export interface EngineRevert {
	messageID: string;
	files: readonly string[];
}

export interface EngineSessionSummary {
	id: string;
	title: string;
	parentID?: string;
	agent?: string;
	busy?: boolean;
	createdAt: number;
	updatedAt: number;
	directory?: string;
}

export interface EngineSessionListOptions {
	/** Defaults to the engine working directory. */
	directory?: string;
	limit?: number;
	search?: string;
	/** `null` lists root sessions; a session ID lists its children. */
	parentID?: string | null;
}

export interface EnginePromptFile {
	uri: string;
	name?: string;
}

export interface EnginePromptOptions {
	/** `steer` interrupts/steers the active turn; `queue` waits for it to finish. */
	delivery?: "steer" | "queue";
	/** Wait for the turn to settle. Defaults to true when the session is idle. */
	wait?: boolean;
	/** Subagents referenced with @mentions in the prompt. */
	agents?: readonly string[];
	/** Files attached to the prompt. */
	files?: readonly EnginePromptFile[];
}

export interface EnginePermissionRule {
	action: string;
	resource: string;
	effect: "allow" | "deny" | "ask";
}

export interface EngineSessionOptions {
	directory: string;
	model?: EngineModelRef;
	agent?: string;
	permissions?: readonly EnginePermissionRule[];
}

export type IoEvent =
	| { type: "connected" }
	| { type: "turn_started"; sessionID: string }
	| {
			type: "turn_ended";
			sessionID: string;
			outcome: "succeeded" | "failed" | "interrupted";
			error?: string;
	  }
	| { type: "text_started"; sessionID: string; messageID: string }
	| { type: "text_delta"; sessionID: string; messageID: string; delta: string }
	| { type: "text_ended"; sessionID: string; messageID: string }
	| { type: "reasoning_started"; sessionID: string; messageID: string }
	| { type: "reasoning_delta"; sessionID: string; messageID: string; delta: string }
	| { type: "reasoning_ended"; sessionID: string; messageID: string }
	| { type: "tool_started"; sessionID: string; toolCallID: string; name: string }
	| {
			type: "tool_updated";
			sessionID: string;
			toolCallID: string;
			name?: string;
			delta?: string;
			input?: unknown;
	  }
	| {
			type: "tool_called";
			sessionID: string;
			toolCallID: string;
			name?: string;
			input?: unknown;
			executed?: boolean;
	  }
	| { type: "tool_progress"; sessionID: string; toolCallID: string; metadata?: unknown }
	| {
			type: "tool_finished";
			sessionID: string;
			toolCallID: string;
			name?: string;
			status: "success" | "error";
			content?: unknown;
			error?: string;
			metadata?: unknown;
	  }
	| { type: "permission_requested"; sessionID: string; request: EnginePermissionRequest }
	| {
			type: "permission_resolved";
			sessionID: string;
			requestID: string;
			decision: PermissionDecision;
	  }
	| { type: "compaction_started"; sessionID: string; reason: "auto" | "manual" }
	| {
			type: "compaction_ended";
			sessionID: string;
			reason: "auto" | "manual";
			text?: string;
			tokens?: EngineTokenUsage;
	  }
	| { type: "compaction_failed"; sessionID: string; reason: "auto" | "manual"; error: string }
	| {
			type: "retry_scheduled";
			sessionID: string;
			attempt: number;
			at: number;
			error: string;
	  }
	| { type: "queue_changed"; sessionID: string; pending: number }
	| { type: "usage_updated"; sessionID: string; tokens: EngineTokenUsage; cost: number }
	| { type: "form_requested"; sessionID: string; form: EngineForm }
	| { type: "form_resolved"; sessionID: string; formID: string; status: "answered" | "cancelled" }
	| { type: "idle"; sessionID: string }
	| { type: "error"; sessionID?: string; message: string };

export interface EngineSession {
	readonly id: string;
	readonly model: EngineModelRef | undefined;
	readonly agent: string | undefined;
	readonly parentID: string | undefined;
	readonly revert: EngineRevert | undefined;
	subscribe(listener: (event: IoEvent) => void): () => void;
	prompt(text: string, options?: EnginePromptOptions): Promise<void>;
	abort(): Promise<void>;
	compact(): Promise<void>;
	fork(before?: string): Promise<EngineSession>;
	setModel(model: EngineModelRef): Promise<void>;
	setAgent(agentID: string): Promise<void>;
	move(directory: string): Promise<void>;
	stageRevert(messageID: string): Promise<void>;
	activateSkill(skillID: string): Promise<void>;
	runCommand(name: string, text: string): Promise<void>;
	replyForm(formID: string, answer: Record<string, EngineFormValue>): Promise<void>;
	cancelForm(formID: string, message?: string): Promise<void>;
	clearRevert(): Promise<void>;
	commitRevert(): Promise<void>;
	respondPermission(requestID: string, decision: PermissionDecision, message?: string): Promise<void>;
	setPermissions(permissions: readonly EnginePermissionRule[]): Promise<void>;
	stats(): Promise<EngineStats>;
	messages(): Promise<readonly EngineMessage[]>;
	diff(): Promise<readonly EngineFileDiff[]>;
	dispose(): Promise<void>;
}

export interface AgentEngine {
	readonly kind: EngineKind;
	listModels(): Promise<readonly EngineModel[]>;
	listAgents(): Promise<readonly EngineAgent[]>;
	listCommands(): Promise<readonly EngineCommand[]>;
	listSavedPermissions(): Promise<readonly EngineSavedPermission[]>;
	removeSavedPermission(id: string): Promise<void>;
	archiveSession(sessionID: string, archived?: boolean): Promise<void>;
	listWorktrees(): Promise<readonly EngineWorktree[]>;
	createWorktree(name?: string): Promise<EngineWorktree>;
	removeWorktree(directory: string, force?: boolean): Promise<void>;
	listMcp(): Promise<readonly EngineMcpServer[]>;
	connectMcp(name: string): Promise<void>;
	disconnectMcp(name: string): Promise<void>;
	listSkills(): Promise<readonly EngineSkill[]>;
	usage(): Promise<EngineUsage | undefined>;
	createSession(options: EngineSessionOptions): Promise<EngineSession>;
	resumeSession(sessionID: string): Promise<EngineSession>;
	listSessions(options?: EngineSessionListOptions): Promise<readonly EngineSessionSummary[]>;
	renameSession(sessionID: string, title: string): Promise<void>;
	deleteSession(sessionID: string): Promise<void>;
	close(): Promise<void>;
}
