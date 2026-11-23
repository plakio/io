import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

test("io shell redacts provider and custom environment variables", { skip: !supported }, async () => {
	const { runShellCommand } = await import("../src/engine/shell-plugin.js");
	const originalProvider = process.env.OPENCODE_API_KEY;
	const originalCustom = process.env.IO_TEST_SECRET;
	process.env.OPENCODE_API_KEY = "provider-secret";
	process.env.IO_TEST_SECRET = "custom-secret";
	try {
		const result = await runShellCommand(
			'printf "%s|%s|%s" "$OPENCODE_API_KEY" "$IO_TEST_SECRET" "$PATH"',
			{ cwd: process.cwd(), envNames: ["IO_TEST_SECRET"] },
		);
		assert.equal(result.exitCode, 0);
		assert.match(result.output, /^\|\|/);
		assert.match(result.output, /\/usr|bin/);

		const failed = await runShellCommand("exit 3", { cwd: process.cwd() });
		assert.equal(failed.exitCode, 3);
	} finally {
		if (originalProvider === undefined) delete process.env.OPENCODE_API_KEY;
		else process.env.OPENCODE_API_KEY = originalProvider;
		if (originalCustom === undefined) delete process.env.IO_TEST_SECRET;
		else process.env.IO_TEST_SECRET = originalCustom;
	}
});

test("io security plugin replaces the shell tool and keeps the permission flow", { skip: !supported }, async () => {
	const { startMockModelServer, createMockPlugin } = await import("./opencode-mock.js");
	const { OpenCodeEngine } = await import("../src/engine/opencode.js");
	const { createIoSecurityPlugin } = await import("../src/engine/shell-plugin.js");
	const root = mkdtempSync(join(tmpdir(), "io-shell-plugin-"));
	const server = await startMockModelServer();
	const engine = await OpenCodeEngine.create({
		cwd: root,
		configDir: join(root, "config"),
		databasePath: join(root, "db", "opencode.db"),
		plugins: [
			await createMockPlugin(server.url),
			createIoSecurityPlugin({ cwd: root, envNames: ["IO_TEST_SECRET"] }),
		],
	});

	try {
		const session = await engine.createSession({
			directory: root,
			model: { provider: "mock", id: "mock-1" },
			permissions: [{ action: "shell", resource: "*", effect: "allow" }],
		});
		const tools: Array<{ status: string; content?: unknown }> = [];
		session.subscribe((event) => {
			if (event.type === "tool_finished") tools.push({ status: event.status, content: event.content });
		});
		await session.prompt("run tool");
		assert.equal(tools.length, 1);
		assert.equal(tools[0]?.status, "success");
		assert.match(JSON.stringify(tools[0]?.content), /io-tool-test/);
		await session.dispose();
	} finally {
		await engine.close();
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
