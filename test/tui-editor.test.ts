import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("editText opens an editor and returns the edited prompt", async () => {
	const { editText } = await import("../src/tui/next/editor.js");
	const root = mkdtempSync(join(tmpdir(), "io-editor-test-"));
	const script = join(root, "editor.sh");
	writeFileSync(script, '#!/bin/sh\nprintf "\\nedited line\\n" >> "$1"\n');
	chmodSync(script, 0o755);
	try {
		const result = editText("start", { editor: script, cwd: root });
		assert.equal(result.saved, true);
		assert.match(result.text, /start/);
		assert.match(result.text, /edited line/);

		const failed = editText("unchanged", { editor: "/bin/false", cwd: root });
		assert.equal(failed.saved, false);
		assert.equal(failed.text, "unchanged");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
