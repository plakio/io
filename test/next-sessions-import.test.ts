import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionImportHost, TransferMessage } from "../src/commands/next-sessions.js";
import { importPiSessions, parsePiSession, pruneSessions } from "../src/commands/next-sessions.js";

const SESSION = [
	'{"type":"session","id":"pi_1","cwd":"/tmp","timestamp":"2026-01-01T00:00:00.000Z","version":1}',
	'{"type":"model_change","provider":"opencode","modelId":"model-a"}',
	'{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hello there"}],"timestamp":"2026-01-01T00:00:01.000Z"}}',
	'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hi back"}],"timestamp":"2026-01-01T00:00:02.000Z"}}',
	'{"type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"ignored"}],"timestamp":"2026-01-01T00:00:03.000Z"}}',
].join("\n");

test("parsePiSession keeps user and assistant text", () => {
	const parsed = parsePiSession(SESSION);
	assert.ok(parsed);
	assert.equal(parsed.piID, "pi_1");
	assert.equal(parsed.title, "hello there");
	assert.equal(parsed.messages.length, 2);
	assert.equal(parsed.messages[0]?.type, "user");
	assert.equal(parsed.messages[1]?.model?.id, "model-a");
});

test("importPiSessions creates a transfer session and removes the temp session", async () => {
	const root = mkdtempSync(join(tmpdir(), "io-pi-sessions-"));
	const file = join(root, "session.jsonl");
	writeFileSync(file, SESSION);
	let imported: { info: Record<string, unknown>; messages: TransferMessage[] } | undefined;
	const removed: string[] = [];
	const host: SessionImportHost = {
		sessions: {
			create: async () => ({ id: "temp" }),
			remove: async ({ sessionID }) => {
				removed.push(sessionID);
			},
			list: async () => ({ data: [] }),
		},
		experimental: {
			session: {
				export: async () => ({ info: { projectID: "project", cost: 0 } }),
				import: async (input) => {
					imported = { info: input.info, messages: input.messages };
					return { id: "ses_imported" };
				},
			},
		},
		close: async () => {},
	};
	let output = "";
	const code = await importPiSessions(host, root, "/tmp", {
		stdout: (text) => {
			output += text;
		},
		stderr: () => {},
	});
	assert.equal(code, 0);
	assert.equal(imported?.messages.length, 2);
	assert.equal(imported?.info.metadata && (imported.info.metadata as Record<string, unknown>).piSessionId, "pi_1");
	assert.deepEqual(removed, ["temp"]);
	assert.match(output, /Imported 1 session/);
});


test("pruneSessions respects older-than and dry-run", async () => {
	const deleted: string[] = [];
	const host = {
		list: async () => ({
			data: [
				{ id: "old", title: "Old", updatedAt: Date.now() - 10 * 86_400_000 },
				{ id: "new", title: "New", updatedAt: Date.now() },
			],
		}),
		deleteSession: async (id: string) => {
			deleted.push(id);
		},
	};
	let output = "";
	const dry = await pruneSessions(host, "/tmp", 7, false, {
		stdout: (text) => {
			output += text;
		},
		stderr: () => {},
	});
	assert.equal(dry, 0);
	assert.deepEqual(deleted, []);
	assert.match(output, /would delete old/);
	await pruneSessions(host, "/tmp", 7, true, { stdout: () => {}, stderr: () => {} });
	assert.deepEqual(deleted, ["old"]);
});
