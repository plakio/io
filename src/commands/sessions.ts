import { resolvePaths, type IoPaths } from "../config.js";
import { formatCount, oneLine } from "../format.js";
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

export async function runSessions(paths: IoPaths = resolvePaths(), cwd = process.cwd()): Promise<void> {
	const sessions = await listSessions(paths, cwd);
	if (sessions.length === 0) {
		process.stdout.write(`No sessions for ${cwd}.\n`);
		return;
	}
	process.stdout.write(`Sessions for ${cwd}\n\n`);
	for (const session of sessions.slice(0, 30)) {
		const id = session.id.slice(0, 12);
		const name = session.name ? `${session.name} · ` : "";
		const first = oneLine(session.firstMessage || "(no messages)", 70);
		process.stdout.write(
			`${id}  ${formatDate(session.modified).padEnd(10)} ${formatCount(session.messageCount).padStart(4)} msgs  ${name}${first}\n`,
		);
	}
	if (sessions.length > 30) {
		process.stdout.write(`\n… ${sessions.length - 30} older sessions not shown\n`);
	}
	process.stdout.write(`\nResume with: io --session <id>   or   io --continue\n`);
}
