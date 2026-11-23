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
	const { getTreeSitterClient } = await import("@opentui/core");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoDiffViewer } = await import("../src/tui/next/diff-viewer.js");

	await getTreeSitterClient().initialize();
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
		turnDiff: async () => [{ path: "src/turn.ts", patch: BRANCH }],
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

		const branch = await viewer.cycleScope();
		assert.equal(branch, "branch");
		assert.equal(viewer.currentScope, "branch");
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /src\/c\.ts/);
		await viewer.cycleScope();
		await viewer.cycleScope();
		assert.equal(viewer.currentScope, "turn");
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /src\/turn\.ts/);
		assert.deepEqual(scopes, ["working", "branch", "committed"]);

		assert.equal(viewer.toggleTree(), undefined);
		assert.equal(viewer.isTreeVisible, false);
		viewer.nextHunk(1);
	} finally {
		viewer.dispose();
		shell.dispose();
		await setup.dispose();
	}
});

test("io diff viewer highlights code inside a patch", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { getTreeSitterClient } = await import("@opentui/core");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoDiffViewer } = await import("../src/tui/next/diff-viewer.js");

	await getTreeSitterClient().initialize();
	const setup = await createTestRenderer({ width: 120, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	const patch = `diff --git a/src/code.ts b/src/code.ts
--- a/src/code.ts
+++ b/src/code.ts
@@ -1 +1 @@
-const old: number = 1
+const fresh: string = "x"
`;
	const viewer = new IoDiffViewer({
		renderer: setup.renderer,
		shell,
		cwd: "/home/oscar/project",
		loadDiff: async () => [{ path: "src/code.ts", patch }],
	});

	try {
		await viewer.open("working");
		await setup.waitForFrame((frame) => frame.includes('const fresh: string = "x"'));
		let line: Array<{ text: string; fg: { toInts: () => number[] } }> | undefined;
		let colors = new Set<string>();
		for (let attempt = 0; attempt < 40 && colors.size < 3; attempt++) {
			await setup.renderOnce();
			line = setup
				.captureSpans()
				.lines.map((captured) => captured.spans)
				.find((spans) => spans.map((span) => span.text).join("").includes('const fresh: string = "x"'));
			colors = new Set(line?.map((span) => span.fg.toInts().join(",")) ?? []);
			if (colors.size < 3) await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.ok(line, "expected the patched code line in the frame");
		assert.ok(colors.size >= 3, `expected highlighted diff, got ${colors.size} color(s)`);
	} finally {
		viewer.dispose();
		shell.dispose();
		await setup.dispose();
	}
});

test("io diff viewer filters files by path", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { getTreeSitterClient } = await import("@opentui/core");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoDiffViewer } = await import("../src/tui/next/diff-viewer.js");

	await getTreeSitterClient().initialize();
	const setup = await createTestRenderer({ width: 110, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	const viewer = new IoDiffViewer({
		renderer: setup.renderer,
		shell,
		cwd: "/home/oscar/project",
		fileFilter: "b.ts",
		loadDiff: async () => [
			{ path: "src/a.ts", patch: WORKING.split(/(?=diff --git)/)[0] ?? "" },
			{ path: "src/b.ts", patch: BRANCH },
		],
	});

	try {
		await viewer.open("working");
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /src\/b\.ts/);
		assert.doesNotMatch(frame, /src\/a\.ts/);
	} finally {
		viewer.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
