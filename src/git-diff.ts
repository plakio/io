import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitDiffResult {
	ok: boolean;
	text: string;
	truncated?: boolean;
}

const MAX_LINES = 500;
const MAX_CHARS = 80_000;

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		timeout: 15_000,
	});
	return result.stdout;
}

function truncate(text: string): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	let truncated = false;
	let selected = lines;
	if (lines.length > MAX_LINES) {
		selected = lines.slice(0, MAX_LINES);
		truncated = true;
	}
	let output = selected.join("\n");
	if (output.length > MAX_CHARS) {
		output = output.slice(0, MAX_CHARS);
		truncated = true;
	}
	if (truncated) {
		output += `\n\n[output truncated at ${MAX_LINES} lines / ${Math.round(MAX_CHARS / 1000)} KB]`;
	}
	return { text: output.trimEnd(), truncated };
}

export async function getGitDiff(cwd: string, path?: string): Promise<GitDiffResult> {
	try {
		const inside = (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
		if (inside !== "true") {
			return { ok: false, text: `Not inside a git work tree: ${cwd}` };
		}
	} catch {
		return { ok: false, text: `Not a git repository: ${cwd}` };
	}

	const pathArgs = path ? ["--", path] : [];
	try {
		const status = (await git(cwd, ["status", "--short", "--branch", ...pathArgs])).trimEnd();
		const hasHead = await git(cwd, ["rev-parse", "--verify", "HEAD"]).then(
			() => true,
			() => false,
		);
		const diffTarget = hasHead ? ["HEAD"] : [];
		const stat = (await git(cwd, ["diff", ...diffTarget, "--stat", "--no-color", ...pathArgs])).trimEnd();
		const patch = (await git(cwd, ["diff", ...diffTarget, "--no-color", ...pathArgs])).trimEnd();

		if (!stat && !patch) {
			return {
				ok: true,
				text: `${status || "## no branch information"}\n\nWorking tree clean.`,
			};
		}

		const combined = [status, stat, patch].filter((part) => part.length > 0).join("\n\n");
		const bounded = truncate(combined);
		return { ok: true, text: bounded.text, truncated: bounded.truncated };
	} catch (error) {
		return {
			ok: false,
			text: `Could not read git changes: ${(error as Error).message}`,
		};
	}
}
