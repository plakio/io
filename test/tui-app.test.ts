import assert from "node:assert/strict";
import test from "node:test";
import type {
	AgentEngine,
	EngineFileDiff,
	EngineMessage,
	EngineModel,
	EngineModelRef,
	EngineSession,
	EngineSessionOptions,
	EngineSessionSummary,
	EngineStats,
	EngineTokenUsage,
	IoEvent,
	PermissionDecision,
} from "../src/engine/types.js";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

const usage: EngineTokenUsage = { input: 12, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

class FakeSession implements EngineSession {
	readonly id: string;
	readonly model: EngineModelRef | undefined;
	private listeners = new Set<(event: IoEvent) => void>();
	disposed = false;

	constructor(id = "ses_app", model: EngineModelRef = { provider: "mock", id: "mock-1" }) {
		this.id = id;
		this.model = model;
	}

	subscribe(listener: (event: IoEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		const emit = (event: IoEvent) => {
			for (const listener of this.listeners) listener(event);
		};
		emit({ type: "turn_started", sessionID: this.id });
		emit({ type: "text_started", sessionID: this.id, messageID: "m1" });
		emit({ type: "text_delta", sessionID: this.id, messageID: "m1", delta: `echo: ${text}` });
		emit({ type: "text_ended", sessionID: this.id, messageID: "m1" });
		emit({ type: "usage_updated", sessionID: this.id, tokens: usage, cost: 0.01 });
		emit({ type: "turn_ended", sessionID: this.id, outcome: "succeeded" });
	}

	async abort(): Promise<void> {}
	async compact(): Promise<void> {}
	async fork(): Promise<EngineSession> {
		return new FakeSession("ses_forked", this.model);
	}
	async setModel(): Promise<void> {}
	async respondPermission(_requestID: string, _decision: PermissionDecision): Promise<void> {}
	async setPermissions(): Promise<void> {}
	async stats(): Promise<EngineStats> {
		return {
			sessionID: this.id,
			model: this.model,
			tokens: usage,
			cost: 0.01,
			contextUsed: 120,
			contextWindow: 1000,
			contextPercent: 12,
		};
	}
	async messages(): Promise<readonly EngineMessage[]> {
		return [];
	}
	async diff(): Promise<readonly EngineFileDiff[]> {
		return [];
	}
	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

class FakeEngine implements AgentEngine {
	readonly kind = "opencode" as const;
	closed = false;
	sessions: FakeSession[] = [new FakeSession()];

	async listModels(): Promise<readonly EngineModel[]> {
		return [
			{
				provider: "mock",
				id: "mock-1",
				name: "Mock 1",
				contextWindow: 1000,
				maxTokens: 100,
				reasoning: false,
				variants: [],
				input: ["text"],
				output: ["text"],
			},
		];
	}
	async createSession(options: EngineSessionOptions): Promise<EngineSession> {
		const session = new FakeSession(`ses_${this.sessions.length + 1}`, options.model);
		this.sessions.push(session);
		return session;
	}
	async resumeSession(sessionID: string): Promise<EngineSession> {
		return this.sessions.find((session) => session.id === sessionID) ?? this.sessions[0]!;
	}
	async listSessions(): Promise<readonly EngineSessionSummary[]> {
		return this.sessions.map((session) => ({
			id: session.id,
			title: session.id,
			createdAt: 1,
			updatedAt: 2,
		}));
	}
	async renameSession(): Promise<void> {}
	async deleteSession(): Promise<void> {}
	async close(): Promise<void> {
		this.closed = true;
	}
}

test("io next app wires engine events into the transcript and footer", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoNextApp } = await import("../src/tui/next/app.js");

	const setup = await createTestRenderer({ width: 110, height: 32 });
	const engine = new FakeEngine();
	const app = await IoNextApp.create({
		cwd: "/home/oscar/project",
		renderer: setup.renderer,
		engine,
	});
	try {
		await app.submit("hello", "prompt");
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /hello/);
		assert.match(frame, /echo: hello/);
		assert.match(frame, /mock\/mock-1/);

		await app.submit("/help", "command");
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /\/model/);

		await app.submit("/model", "command");
		await app.submit("/sessions", "command");
		await app.submit("/compact", "command");
		await app.submit("/new", "command");
		await app.submit("!printf inline-shell", "shell");
		await app.submit("/queue", "command");
		await setup.renderOnce();

		await app.shutdown(0);
		assert.equal(engine.closed, true);
	} finally {
		await setup.dispose();
	}
});

test("io next app runs slash commands typed in the composer", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoNextApp } = await import("../src/tui/next/app.js");

	const setup = await createTestRenderer({ width: 110, height: 32 });
	const engine = new FakeEngine();
	const app = await IoNextApp.create({
		cwd: "/home/oscar/project",
		renderer: setup.renderer,
		engine,
	});
	try {
		await setup.mockInput.typeText("/help");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /\/model/);
		assert.match(frame, /\/quit/);
		assert.match(frame, /Ctrl\+P/);

		await setup.mockInput.typeText("/nope");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /unknown command: \/nope/);

		await app.submit("/models", "command");
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /mock\/mock-1/);

		await app.submit("/model mock/mock-1", "command");
		await setup.renderOnce();
		await app.submit("/model missing/model", "command");
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /unknown model: missing\/model/);

		await setup.mockInput.typeText("/he");
		setup.mockInput.pressTab();
		await setup.renderOnce();
		const composer = (app as unknown as { composer: { text: string } }).composer;
		assert.equal(composer.text, "/help ");

		await app.shutdown(0);
	} finally {
		await setup.dispose();
	}
});
