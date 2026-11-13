import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths, type IoPaths } from "../config.js";
import { formatCount, oneLine } from "../format.js";
import { LinePrompter } from "../term-prompt.js";
import { listSessions } from "../session.js";

function formatDate(date: Date): string {
	const now = Date.now();
	const diff = now - date.getTime();
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
	return date.toISOString().slice(0, 10);
}

function pruneSessions(paths: IoPaths, olderThanDays: number, yes: boolean): void {
	const cutoff = Date.now() - olderThanDays * 86_400_000;
	let files: string[] = [];
	try {
		files = readdirSync(paths.sessionsDir);
	} catch {
		process.stdout.write(`No session directory at ${paths.sessionsDir}.\n`);
		return;
	}
	const candidates: Array<{ path: string; size: number }> = [];
	for (const name of files) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(paths.sessionsDir, name);
		try {
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
			candidates.push({ path, size: stat.size });
		} catch {
			// Ignore files that disappeared or cannot be inspected.
		}
	}
	const bytes = candidates.reduce((total, entry) => total + entry.size, 0);
	process.stdout.write(
		`${candidates.length} session${candidates.length === 1 ? "" : "s"} older than ${olderThanDays} days (${(bytes / 1024 / 1024).toFixed(1)} MB).\n`,
	);
	for (const candidate of candidates) {
		if (!yes) process.stdout.write(`  would delete ${candidate.path}\n`);
	}
	if (!yes) {
		process.stdout.write("Dry run. Re-run with --yes to delete these files.\n");
		return;
	}
	let deleted = 0;
	for (const candidate of candidates) {
		try {
			rmSync(candidate.path, { force: true });
			deleted += 1;
		} catch (error) {
			process.stderr.write(`io: could not delete ${candidate.path}: ${(error as Error).message}\n`);
		}
	}
	process.stdout.write(`Deleted ${deleted} session${deleted === 1 ? "" : "s"}.\n`);
}

export async function runSessions(
	paths: IoPaths = resolvePaths(),
	cwd = process.cwd(),
	prune?: { olderThanDays: number; yes: boolean },
): Promise<void> {
	if (prune) {
		pruneSessions(paths, prune.olderThanDays, prune.yes);
		return;
	}
	const sessions = await listSessions(paths, cwd);
	if (sessions.length === 0) {
		process.stdout.write(`No sessions for ${cwd}.\n`);
		return;
	}
	process.stdout.write(`Sessions for ${cwd}\n\n`);
	const visible = sessions.slice(0, 30);
	for (const [index, session] of visible.entries()) {
		const id = session.id.slice(0, 12);
		const name = session.name ? `${session.name} · ` : "";
		const first = oneLine(session.firstMessage || "(no messages)", 62);
		process.stdout.write(
			`${String(index + 1).padStart(2)}. ${id}  ${formatDate(session.modified).padEnd(10)} ${formatCount(session.messageCount).padStart(4)} msgs  ${name}${first}\n`,
		);
	}
	if (sessions.length > 30) {
		process.stdout.write(`\n… ${sessions.length - 30} older sessions not shown\n`);
	}
	process.stdout.write(`\nResume with: io --session <id>   or   io --continue\n`);

	if (!process.stdin.isTTY || !process.stdout.isTTY) return;
	const prompter = new LinePrompter();
	try {
		const answer = (await prompter.readLine("Resume a session? Enter number (blank to exit): ")).trim();
		const number = Number(answer);
		if (Number.isInteger(number) && number >= 1 && number <= visible.length) {
			const selected = visible[number - 1];
			if (selected) {
				const { runInteractive } = await import("../main.js");
				process.exitCode = await runInteractive({ continueSession: false, sessionId: selected.id });
			}
		}
	} finally {
		prompter.close();
	}
}
