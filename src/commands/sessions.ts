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

export async function runSessions(paths: IoPaths = resolvePaths(), cwd = process.cwd()): Promise<void> {
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
