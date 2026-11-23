import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface EditorResult {
	text: string;
	saved: boolean;
}

/** Open $EDITOR on a temporary file and return the edited prompt. */
export function editText(text: string, options: { cwd?: string; editor?: string } = {}): EditorResult {
	const directory = mkdtempSync(join(tmpdir(), "io-prompt-"));
	const file = join(directory, "prompt.md");
	writeFileSync(file, text);
	const editor = options.editor ?? process.env.VISUAL ?? process.env.EDITOR ?? "vi";
	const quoted = `'${file.replaceAll("'", "'\\''")}'`;
	try {
		const result = spawnSync(`${editor} ${quoted}`, {
			cwd: options.cwd,
			shell: true,
			stdio: "inherit",
			env: process.env,
		});
		const edited = readFileSync(file, "utf8");
		return { text: edited, saved: result.status === 0 };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
