import assert from "node:assert/strict";
import test from "node:test";
import type { DiffFile, DiffScope } from "../src/tui/next/diff-viewer.js";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

const WORKING = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-old
+new
 context
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
-before
+after
 same
`;

const BRANCH = `diff --git a/src/c.ts b/src/c.ts
--- a/src/c.ts
+++ b/src/c.ts
@@ -1 +1 @@
-old
+branch
`;

test("splitPatch separates files and keeps patches", async () => {
	const { splitPatch } = await import("../src/tui/next/diff-viewer.js");
	const files = splitPatch(WORKING);
	assert.deepEqual(files.map((file) => file.path), ["src/a.ts", "src/b.ts"]);
	assert.match(files[0]?.patch ?? "", /-old\n\+new/);
});

test("io diff viewer renders files, switches view, scope and reviewed state", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoDiffViewer } = await import("../src/tui/next/diff-viewer.js");

	const setup = await createTestRenderer({ width: 130, height: 36 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	const scopes: DiffScope[] = [];
	const files: Record<DiffScope, DiffFile[]> = {
		working: [
			{ path: "src/a.ts", patch: WORKING.split(/(?=diff --git)/)[0] ?? "" },
			{ path: "src/b.ts", patch: `diff --git a/src/b.ts b/src/b.ts\n${WORKING.split(/(?=diff --git)/)[1] ?? ""}` },
		],
		branch: [{ path: "src/c.ts", patch: BRANCH }],
		committed: [],
		turn: [],
	};
	const viewer = new IoDiffViewer({
		renderer: setup.renderer,
		shell,
		cwd: "/home/oscar/project",
		loadDiff: async (scope) => {
			scopes.push(scope);
			return files[scope];
		},
	});

	try {
		await viewer.open("working");
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Diff · working · unified/);
		assert.match(frame, /src\/a\.ts/);
		assert.match(frame, /src\/b\.ts/);
		assert.match(frame, /\+ new/);
		assert.equal(viewer.selectedFile?.path, "src/a.ts");

		assert.equal(viewer.selectFile(1), true);
		assert.equal(viewer.selectedFile?.path, "src/b.ts");
		assert.equal(viewer.toggleView(), true);
		assert.equal(viewer.currentView, "split");
		assert.equal(viewer.markReviewed(), true);
		assert.deepEqual(viewer.reviewedFiles, ["src/b.ts"]);

		const scope = await viewer.cycleScope();
		assert.equal(scope, "branch");
		assert.equal(viewer.currentScope, "branch");
		assert.deepEqual(scopes, ["working", "branch"]);
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /src\/c\.ts/);

		assert.equal(viewer.toggleTree(), undefined);
		assert.equal(viewer.isTreeVisible, false);
		viewer.nextHunk(1);
	} finally {
		viewer.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
