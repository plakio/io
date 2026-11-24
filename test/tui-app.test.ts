import assert from "node:assert/strict";
import test from "node:test";
import type {
	AgentEngine,
	EngineAgent,
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
	agent = "build";
	parentID: string | undefined;
	revert: { messageID: string; files: readonly string[] } | undefined;
	messageList: EngineMessage[] = [];
	lastPromptOptions: unknown;
	lastCommand: { name: string; text: string } | undefined;
	hold = false;
	aborted = 0;
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

	async prompt(text: string, options?: unknown): Promise<void> {
		this.lastPromptOptions = options;
		const emit = (event: IoEvent) => {
			for (const listener of this.listeners) listener(event);
		};
		emit({ type: "turn_started", sessionID: this.id });
		if (this.hold) return;
		emit({ type: "text_started", sessionID: this.id, messageID: "m1" });
		emit({ type: "text_delta", sessionID: this.id, messageID: "m1", delta: `echo: ${text}` });
		emit({ type: "text_ended", sessionID: this.id, messageID: "m1" });
		emit({ type: "usage_updated", sessionID: this.id, tokens: usage, cost: 0.01 });
		emit({ type: "turn_ended", sessionID: this.id, outcome: "succeeded" });
	}

	async abort(): Promise<void> {
		this.aborted += 1;
		for (const listener of this.listeners) listener({ type: "turn_ended", sessionID: this.id, outcome: "interrupted" });
	}
	async compact(): Promise<void> {}
	async fork(): Promise<EngineSession> {
		return new FakeSession("ses_forked", this.model);
	}
	async setModel(): Promise<void> {}
	async setAgent(agentID: string): Promise<void> {
		this.agent = agentID;
	}
	async move(): Promise<void> {}
	async activateSkill(): Promise<void> {}
	async runCommand(name: string, text: string): Promise<void> {
		this.lastCommand = { name, text };
	}
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
		return this.messageList;
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
	commandList: Array<{ name: string; description?: string }> = [];
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
	async listCommands(): Promise<readonly { name: string; description?: string }[]> {
		return this.commandList;
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
		return [
			{ id: "build", name: "Build", mode: "primary", hidden: false },
			{ id: "plan", name: "Plan", mode: "primary", hidden: false },
			{ id: "general", name: "General", mode: "subagent", hidden: false },
			{ id: "explore", name: "Explore", mode: "subagent", hidden: false },
			{ id: "compaction", name: "Compaction", mode: "primary", hidden: true },
		];
	}
	async createSession(options: EngineSessionOptions): Promise<EngineSession> {
		const session = new FakeSession(`ses_${this.sessions.length + 1}`, options.model);
		session.agent = options.agent ?? "build";
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
		assert.match(setup.captureCharFrame(), /Ctrl\+X j/);

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
		assert.match(frame, /Ctrl\+X j/);
		assert.match(frame, /Esc twice/);

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

test("io next app treats /q as an alias for /quit", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoNextApp } = await import("../src/tui/next/app.js");

	const setup = await createTestRenderer({ width: 100, height: 24 });
	const engine = new FakeEngine();
	const app = await IoNextApp.create({
		cwd: "/home/oscar/project",
		renderer: setup.renderer,
		engine,
	});
	try {
		await app.submit("/q", "command");
		assert.equal(await app.run(), 0);
		assert.equal(engine.closed, true);
	} finally {
		await setup.dispose();
	}
});

test("io next app cycles primary agents and lists every built-in", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoNextApp } = await import("../src/tui/next/app.js");

	const setup = await createTestRenderer({ width: 110, height: 36, kittyKeyboard: true });
	const engine = new FakeEngine();
	const app = await IoNextApp.create({
		cwd: "/home/oscar/project",
		renderer: setup.renderer,
		engine,
	});
	try {
		assert.equal(app.currentSession?.agent, "build");

		setup.mockInput.pressTab({ shift: true });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await setup.renderOnce();
		assert.equal(app.currentSession?.agent, "plan");

		setup.mockInput.pressTab({ shift: true });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await setup.renderOnce();
		assert.equal(app.currentSession?.agent, "build");

		await app.submit("/agents", "command");
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /General \(general\)/);
		assert.match(frame, /Explore \(explore\)/);
		assert.match(frame, /Compaction \(compaction\)/);
		assert.match(frame, /hidden/);

		await app.shutdown(0);
	} finally {
		await setup.dispose();
	}
});

test("io next app changes the working directory", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoNextApp } = await import("../src/tui/next/app.js");

	const setup = await createTestRenderer({ width: 100, height: 28 });
	const engine = new FakeEngine();
	const app = await IoNextApp.create({
		cwd: "/home/oscar/project",
		renderer: setup.renderer,
		engine,
	});
	try {
		await app.submit("/cd /tmp", "command");
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /\/tmp/);

		await app.submit("/cd /definitely/missing/io-dir", "command");
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /not a directory/);

		await app.shutdown(0);
	} finally {
		await setup.dispose();
	}
});

test("io next app arms Esc before interrupting a running turn", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoNextApp } = await import("../src/tui/next/app.js");

	const setup = await createTestRenderer({ width: 110, height: 30 });
	const engine = new FakeEngine();
	const app = await IoNextApp.create({
		cwd: "/home/oscar/project",
		renderer: setup.renderer,
		engine,
	});
	const session = app.currentSession as FakeSession;
	try {
		session.hold = true;
		await app.submit("keep working", "prompt");
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /esc interrupt/);

		setup.mockInput.pressEscape();
		await new Promise((resolve) => setTimeout(resolve, 50));
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /esc again to interrupt/);
		assert.equal(session.aborted, 0);

		setup.mockInput.pressEscape();
		await new Promise((resolve) => setTimeout(resolve, 50));
		await setup.flush();
		assert.equal(session.aborted, 1);
		assert.doesNotMatch(setup.captureCharFrame(), /esc again to interrupt/);

		await app.shutdown(0);
	} finally {
		await setup.dispose();
	}
});

test("io next app stashes and restores prompt drafts", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoNextApp } = await import("../src/tui/next/app.js");

	const setup = await createTestRenderer({ width: 100, height: 26 });
	const engine = new FakeEngine();
	const app = await IoNextApp.create({
		cwd: "/home/oscar/project",
		renderer: setup.renderer,
		engine,
	});
	const composer = (app as unknown as { composer: { text: string; setText: (value: string) => void } }).composer;
	try {
		composer.setText("draft prompt");
		await app.submit("/stash", "command");
		assert.equal(composer.text, "");

		await app.submit("/stash list", "command");
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /1\. draft prompt/);

		await app.submit("/stash pop", "command");
		assert.equal(composer.text, "draft prompt");

		composer.setText("key draft");
		setup.mockInput.pressKey("x", { ctrl: true });
		setup.mockInput.pressKey("j");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(composer.text, "");
		setup.mockInput.pressKey("x", { ctrl: true });
		setup.mockInput.pressKey("k");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(composer.text, "key draft");

		await app.shutdown(0);
	} finally {
		await setup.dispose();
	}
});

test("io next app renders todowrite results in the plan panel", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoNextApp } = await import("../src/tui/next/app.js");

	const setup = await createTestRenderer({ width: 100, height: 28 });
	const engine = new FakeEngine();
	const app = await IoNextApp.create({
		cwd: "/home/oscar/project",
		renderer: setup.renderer,
		engine,
	});
	const handle = (app as unknown as { handleEvent: (event: IoEvent) => void }).handleEvent.bind(app);
	try {
		handle({ type: "tool_started", sessionID: "ses_2", toolCallID: "t1", name: "todowrite" });
		handle({
			type: "tool_called",
			sessionID: "ses_2",
			toolCallID: "t1",
			input: {
				todos: [
					{ content: "inspect auth flow", status: "completed" },
					{ content: "patch login", status: "in_progress" },
					{ content: "run tests", status: "pending" },
				],
			},
		});
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /\[x\] inspect auth flow/);
		assert.match(frame, /\[~\] patch login/);
		assert.match(frame, /\[ \] run tests/);

		await app.shutdown(0);
	} finally {
		await setup.dispose();
	}
});

test("io next app undoes and redoes the last user message", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoNextApp } = await import("../src/tui/next/app.js");

	const setup = await createTestRenderer({ width: 100, height: 28 });
	const engine = new FakeEngine();
	const app = await IoNextApp.create({
		cwd: "/home/oscar/project",
		renderer: setup.renderer,
		engine,
	});
	const session = app.currentSession as FakeSession;
	const composer = (app as unknown as { composer: { text: string } }).composer;
	try {
		session.messageList = [
			{ id: "m1", role: "user", text: "first prompt", createdAt: 1 },
			{ id: "m2", role: "assistant", text: "first answer", createdAt: 2 },
		];
		await app.submit("/undo", "command");
		assert.equal(session.revert?.messageID, "m1");
		assert.equal(composer.text, "first prompt");
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /first prompt/);

		await app.submit("/redo", "command");
		assert.equal(session.revert, undefined);

		await app.shutdown(0);
	} finally {
		await setup.dispose();
	}
});

test("io next app exports the session to markdown", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { readFileSync, unlinkSync } = await import("node:fs");
	const { IoNextApp } = await import("../src/tui/next/app.js");

	const setup = await createTestRenderer({ width: 100, height: 26 });
	const engine = new FakeEngine();
	const app = await IoNextApp.create({
		cwd: "/home/oscar/project",
		renderer: setup.renderer,
		engine,
	});
	const session = app.currentSession as FakeSession;
	const target = "/tmp/io-app-export-test.md";
	try {
		session.messageList = [
			{ id: "m1", role: "user", text: "add oauth", createdAt: 1 },
			{ id: "m2", role: "assistant", text: "Implemented.", createdAt: 2 },
		];
		await app.submit(`/export ${target}`, "command");
		const markdown = readFileSync(target, "utf8");
		assert.match(markdown, /# io session|# ses_/);
		assert.match(markdown, /add oauth/);
		assert.match(markdown, /Implemented\./);
	} finally {
		try {
			unlinkSync(target);
		} catch {
			// Ignore cleanup when the export failed.
		}
		await app.shutdown(0);
		await setup.dispose();
	}
});

test("io next app passes @subagent mentions to the engine", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoNextApp } = await import("../src/tui/next/app.js");

	const setup = await createTestRenderer({ width: 100, height: 26 });
	const engine = new FakeEngine();
	const app = await IoNextApp.create({
		cwd: "/home/oscar/project",
		renderer: setup.renderer,
		engine,
	});
	const session = app.currentSession as FakeSession;
	try {
		await app.submit("@general investigate the auth flow", "prompt");
		assert.deepEqual((session.lastPromptOptions as { agents?: string[] }).agents, ["general"]);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await setup.renderOnce();
		await app.shutdown(0);
	} finally {
		await setup.dispose();
	}
});

test("io next app attaches files to the next prompt", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { writeFileSync, unlinkSync } = await import("node:fs");
	const { IoNextApp } = await import("../src/tui/next/app.js");

	const setup = await createTestRenderer({ width: 100, height: 26 });
	const engine = new FakeEngine();
	const app = await IoNextApp.create({
		cwd: "/home/oscar/project",
		renderer: setup.renderer,
		engine,
	});
	const session = app.currentSession as FakeSession;
	const target = "/tmp/io-attach-test.txt";
	writeFileSync(target, "attached");
	try {
		await app.submit(`/attach ${target}`, "command");
		await app.submit("read it", "prompt");
		const files = (session.lastPromptOptions as { files?: Array<{ uri: string; name: string }> }).files;
		assert.equal(files?.length, 1);
		assert.equal(files?.[0]?.name, "io-attach-test.txt");
		assert.match(files?.[0]?.uri ?? "", /^file:\/\//);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await setup.renderOnce();
		await app.shutdown(0);
	} finally {
		try {
			unlinkSync(target);
		} catch {
			// Ignore cleanup.
		}
		await setup.dispose();
	}
});

test("io next app runs project markdown commands", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoNextApp } = await import("../src/tui/next/app.js");

	const setup = await createTestRenderer({ width: 100, height: 26 });
	const engine = new FakeEngine();
	engine.commandList = [{ name: "hello", description: "Say hello" }];
	const app = await IoNextApp.create({
		cwd: "/home/oscar/project",
		renderer: setup.renderer,
		engine,
	});
	const session = app.currentSession as FakeSession;
	try {
		await app.submit("/hello world", "command");
		assert.deepEqual(session.lastCommand, { name: "hello", text: "world" });
		await app.shutdown(0);
	} finally {
		await setup.dispose();
	}
});

test("io next app opens and closes agent form sheets", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoNextApp } = await import("../src/tui/next/app.js");

	const setup = await createTestRenderer({ width: 100, height: 28 });
	const engine = new FakeEngine();
	const app = await IoNextApp.create({
		cwd: "/home/oscar/project",
		renderer: setup.renderer,
		engine,
	});
	const handle = (app as unknown as { handleEvent: (event: IoEvent) => void }).handleEvent.bind(app);
	try {
		handle({
			type: "form_requested",
			sessionID: "ses_2",
			form: {
				id: "form_1",
				sessionID: "ses_2",
				title: "Deployment",
				fields: [{ key: "name", title: "Name", type: "string", required: true }],
			},
		});
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /Deployment/);
		handle({ type: "form_resolved", sessionID: "ses_2", formID: "form_1", status: "cancelled" });
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /Deployment/);
		await app.shutdown(0);
	} finally {
		await setup.dispose();
	}
});
