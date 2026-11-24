import assert from "node:assert/strict";
import test from "node:test";
import type {
	AgentEngine,
	EngineAgent,
	EngineFileDiff,
	EngineMessage,
	EngineModel,
	EngineModelRef,
	EnginePermissionRule,
	EngineSession,
	EngineSessionOptions,
	EngineSessionSummary,
	EngineStats,
	IoEvent,
	PermissionDecision,
} from "../src/engine/types.js";
import { runHeadless } from "../src/commands/run.js";

const model: EngineModel = {
	provider: "mock",
	id: "mock-1",
	name: "Mock 1",
	contextWindow: 128_000,
	maxTokens: 8_000,
	reasoning: false,
	variants: [],
	input: ["text"],
	output: ["text"],
};

class FakeRunSession implements EngineSession {
	readonly id = "ses_run";
	readonly model: EngineModelRef = { provider: "mock", id: "mock-1" };
	readonly agent = "build";
	readonly parentID = undefined;
	revert: { messageID: string; files: readonly string[] } | undefined;
	permissionCommand: string | undefined;
	toolError = false;
	decisions: PermissionDecision[] = [];
	permissions: readonly EnginePermissionRule[] = [];
	private listeners = new Set<(event: IoEvent) => void>();
	private resolvePermission: (() => void) | undefined;

	subscribe(listener: (event: IoEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		this.emit({ type: "turn_started", sessionID: this.id });
		if (this.permissionCommand) {
			const request = {
				requestID: "per_1",
				sessionID: this.id,
				action: "shell",
				resources: [this.permissionCommand],
			};
			const wait = new Promise<void>((resolve) => {
				this.resolvePermission = resolve;
			});
			this.emit({ type: "permission_requested", sessionID: this.id, request });
			await wait;
		}
		this.emit({ type: "text_started", sessionID: this.id, messageID: "m1" });
		this.emit({ type: "text_delta", sessionID: this.id, messageID: "m1", delta: `echo: ${text}` });
		this.emit({ type: "text_ended", sessionID: this.id, messageID: "m1" });
		if (this.toolError) {
			this.emit({
				type: "tool_finished",
				sessionID: this.id,
				toolCallID: "t1",
				status: "error",
				error: "command failed",
			});
		}
		this.emit({ type: "turn_ended", sessionID: this.id, outcome: "succeeded" });
	}

	async abort(): Promise<void> {}
	async compact(): Promise<void> {}
	async fork(): Promise<EngineSession> {
		return this;
	}
	async setModel(): Promise<void> {}
	async setAgent(): Promise<void> {}
	async move(): Promise<void> {}
	async activateSkill(): Promise<void> {}
	async runCommand(): Promise<void> {}
	async replyForm(): Promise<void> {}
	async cancelForm(): Promise<void> {}
	async stageRevert(messageID: string): Promise<void> {
		this.revert = { messageID, files: [] };
	}
	async clearRevert(): Promise<void> {
		this.revert = undefined;
	}
	async commitRevert(): Promise<void> {
		this.revert = undefined;
	}
	async setPermissions(permissions: readonly EnginePermissionRule[]): Promise<void> {
		this.permissions = permissions;
	}
	async respondPermission(_requestID: string, decision: PermissionDecision): Promise<void> {
		this.decisions.push(decision);
		this.resolvePermission?.();
		this.resolvePermission = undefined;
	}
	async stats(): Promise<EngineStats> {
		return {
			sessionID: this.id,
			model: this.model,
			tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
			cost: 0.001,
			contextUsed: 10,
			contextWindow: 128_000,
			contextPercent: 0.01,
		};
	}
	async messages(): Promise<readonly EngineMessage[]> {
		return [];
	}
	async diff(): Promise<readonly EngineFileDiff[]> {
		return [];
	}
	async dispose(): Promise<void> {}

	private emit(event: IoEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

class FakeRunEngine implements AgentEngine {
	readonly kind = "opencode" as const;
	readonly session = new FakeRunSession();
	async listModels(): Promise<readonly EngineModel[]> {
		return [model];
	}
	async listCommands(): Promise<readonly never[]> {
		return [];
	}
	async listSavedPermissions(): Promise<readonly never[]> {
		return [];
	}
	async removeSavedPermission(): Promise<void> {}
	async listWorktrees(): Promise<readonly never[]> {
		return [];
	}
	async createWorktree(): Promise<never> {
		throw new Error("not supported");
	}
	async removeWorktree(): Promise<void> {}
	async listMcp(): Promise<readonly never[]> {
		return [];
	}
	async connectMcp(): Promise<void> {}
	async disconnectMcp(): Promise<void> {}
	async listSkills(): Promise<readonly never[]> {
		return [];
	}
	async usage(): Promise<undefined> {
		return undefined;
	}
	async listAgents(): Promise<readonly EngineAgent[]> {
		return [{ id: "build", name: "Build", mode: "primary", hidden: false }];
	}
	async createSession(_options: EngineSessionOptions): Promise<EngineSession> {
		return this.session;
	}
	async resumeSession(): Promise<EngineSession> {
		return this.session;
	}
	async listSessions(): Promise<readonly EngineSessionSummary[]> {
		return [];
	}
	async renameSession(): Promise<void> {}
	async deleteSession(): Promise<void> {}
	async close(): Promise<void> {}
}

test("headless run streams text, applies stats and exits cleanly", async () => {
	const engine = new FakeRunEngine();
	let stdout = "";
	let stderr = "";
	const code = await runHeadless(
		engine,
		{ cwd: process.cwd(), prompt: "hello", stats: true },
		{ stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
	);
	assert.equal(code, 0);
	assert.match(stdout, /echo: hello/);
	assert.match(stderr, /io stats:/);
	assert.ok(engine.session.permissions.some((rule) => rule.action === "shell" && rule.effect === "ask"));
});

test("headless run approves safe commands and rejects dangerous ones", async () => {
	const engine = new FakeRunEngine();
	engine.session.permissionCommand = "echo safe";
	const safeCode = await runHeadless(
		engine,
		{ cwd: process.cwd(), prompt: "safe" },
		{ stdout: () => {}, stderr: () => {} },
	);
	assert.equal(safeCode, 0);
	assert.deepEqual(engine.session.decisions, ["once"]);

	engine.session.decisions = [];
	engine.session.permissionCommand = "rm -rf /";
	const dangerousCode = await runHeadless(
		engine,
		{ cwd: process.cwd(), prompt: "danger" },
		{ stdout: () => {}, stderr: () => {} },
	);
	assert.equal(dangerousCode, 0);
	assert.deepEqual(engine.session.decisions, ["reject"]);
});

test("headless run honors fail-on-tool-error", async () => {
	const engine = new FakeRunEngine();
	engine.session.toolError = true;
	const code = await runHeadless(
		engine,
		{ cwd: process.cwd(), prompt: "fail", failOnToolError: true },
		{ stdout: () => {}, stderr: () => {} },
	);
	assert.equal(code, 1);
});
