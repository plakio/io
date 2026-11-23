import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IoEvent } from "../src/engine/types.js";

const supported = Number(process.versions.node.split(".")[0]) >= 24;

test("OpenCode engine streams text and exposes models, stats and messages", { skip: !supported }, async () => {
	const { startMockModelServer, createMockPlugin } = await import("./opencode-mock.js");
	const { OpenCodeEngine } = await import("../src/engine/opencode.js");
	const root = mkdtempSync(join(tmpdir(), "io-engine-"));
	const server = await startMockModelServer();
	const engine = await OpenCodeEngine.create({
		cwd: root,
		configDir: join(root, "config"),
		databasePath: join(root, "db", "opencode.db"),
		plugins: [await createMockPlugin(server.url)],
	});

	try {
		const models = await engine.listModels();
		assert.ok(
			models.some((model) => model.provider === "mock" && model.id === "mock-1"),
			"mock model should be registered",
		);

		const session = await engine.createSession({
			directory: root,
			model: { provider: "mock", id: "mock-1" },
		});
		const events: IoEvent[] = [];
		let text = "";
		session.subscribe((event) => {
			events.push(event);
			if (event.type === "text_delta") text += event.delta;
		});

		await session.prompt("hello from the test");
		assert.match(text, /Hello from mock/);
		assert.ok(
			events.some((event) => event.type === "turn_started"),
			"turn should start",
		);
		assert.ok(
			events.some((event) => event.type === "turn_ended" && event.outcome === "succeeded"),
			"turn should succeed",
		);

		const stats = await session.stats();
		assert.equal(stats.sessionID, session.id);
		assert.ok(stats.tokens.input >= 0);
		assert.ok(stats.cost >= 0);

		const messages = await session.messages();
		assert.ok(messages.some((message) => message.role === "user" && message.text.length > 0));
		assert.ok(messages.some((message) => message.role === "assistant" && message.text.length > 0));

		const forked = await session.fork();
		assert.notEqual(forked.id, session.id);
		await forked.dispose();

		const listed = await engine.listSessions();
		assert.ok(listed.some((entry) => entry.id === session.id));
		await engine.renameSession(session.id, "renamed session");
		const renamed = await engine.listSessions();
		assert.equal(renamed.find((entry) => entry.id === session.id)?.title, "renamed session");

		await session.dispose();
		await engine.deleteSession(session.id);
		const remaining = await engine.listSessions();
		assert.ok(!remaining.some((entry) => entry.id === session.id));
	} finally {
		await engine.close();
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("OpenCode engine translates tool events and permission requests", { skip: !supported }, async () => {
	const { startMockModelServer, createMockPlugin } = await import("./opencode-mock.js");
	const { OpenCodeEngine } = await import("../src/engine/opencode.js");
	const root = mkdtempSync(join(tmpdir(), "io-engine-tool-"));
	const server = await startMockModelServer();
	const engine = await OpenCodeEngine.create({
		cwd: root,
		configDir: join(root, "config"),
		databasePath: join(root, "db", "opencode.db"),
		plugins: [await createMockPlugin(server.url)],
	});

	try {
		const session = await engine.createSession({
			directory: root,
			model: { provider: "mock", id: "mock-1" },
			permissions: [{ action: "shell", resource: "*", effect: "ask" }],
		});
		const events: IoEvent[] = [];
		let permissionRequests = 0;
		session.subscribe((event) => {
			events.push(event);
			if (event.type === "permission_requested") {
				permissionRequests += 1;
				void session.respondPermission(event.request.requestID, "once");
			}
		});

		await session.prompt("run tool");
		assert.ok(
			events.some((event) => event.type === "tool_started" && event.name === "shell"),
			"tool start should be translated",
		);
		assert.ok(
			events.some((event) => event.type === "tool_finished" && event.status === "success"),
			"tool result should be translated",
		);
		assert.equal(permissionRequests, 1);
		await session.dispose();
	} finally {
		await engine.close();
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
