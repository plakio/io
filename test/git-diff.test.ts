import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getGitDiff } from "../src/git-diff.js";

function tempRepo(): { path: string; cleanup: () => void } {
	const path = mkdtempSync(join(tmpdir(), "io-git-"));
	execFileSync("git", ["init", "-q"], { cwd: path });
	execFileSync("git", ["config", "user.email", "io@example.com"], { cwd: path });
	execFileSync("git", ["config", "user.name", "IO Test"], { cwd: path });
	return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

test("git diff shows status, stat, and patch", async () => {
	const repo = tempRepo();
	try {
		writeFileSync(join(repo.path, "file.txt"), "one\n");
		execFileSync("git", ["add", "file.txt"], { cwd: repo.path });
		execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo.path });
		writeFileSync(join(repo.path, "file.txt"), "one\ntwo\n");
		const result = await getGitDiff(repo.path);
		assert.equal(result.ok, true);
		assert.match(result.text, /file\.txt/);
		assert.match(result.text, /\+two/);
	} finally {
		repo.cleanup();
	}
});

test("git diff reports clean trees and non-repositories", async () => {
	const repo = tempRepo();
	try {
		writeFileSync(join(repo.path, "file.txt"), "one\n");
		execFileSync("git", ["add", "file.txt"], { cwd: repo.path });
		execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo.path });
		const clean = await getGitDiff(repo.path);
		assert.equal(clean.ok, true);
		assert.match(clean.text, /Working tree clean/);

		const missing = await getGitDiff(join(repo.path, "nope"));
		assert.equal(missing.ok, false);
		assert.match(missing.text, /Not a git repository/);
	} finally {
		repo.cleanup();
	}
});
