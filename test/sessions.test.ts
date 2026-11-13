import assert from "node:assert/strict";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runSessions } from "../src/commands/sessions.js";
import { temporaryPaths } from "./helpers.js";

test("sessions prune deletes only old jsonl files when confirmed", async () => {
	const temporary = temporaryPaths("io-prune-");
	try {
		const old = join(temporary.paths.sessionsDir, "old.jsonl");
		const fresh = join(temporary.paths.sessionsDir, "fresh.jsonl");
		const other = join(temporary.paths.sessionsDir, "keep.txt");
		writeFileSync(old, "{}\n");
		writeFileSync(fresh, "{}\n");
		writeFileSync(other, "not a session\n");
		const oldTime = new Date(Date.now() - 60 * 86_400_000);
		utimesSync(old, oldTime, oldTime);

		await runSessions(temporary.paths, process.cwd(), { olderThanDays: 30, yes: true });

		assert.equal(existsSync(old), false);
		assert.equal(existsSync(fresh), true);
		assert.equal(existsSync(other), true);
	} finally {
		temporary.cleanup();
	}
});
