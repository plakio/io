import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

test("io shell frame snapshots at 120 and 80 columns", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");

	for (const [width, height, fixture] of [
		[120, 24, "tui-shell-120.txt"],
		[80, 20, "tui-shell-80.txt"],
	] as const) {
		const setup = await createTestRenderer({ width, height });
		const shell = new IoShell(setup.renderer, {
			cwd: "/home/oscar/project",
			version: "0.2.0",
			branch: "main",
			sessionID: "3f2a",
		});
		try {
			shell.setTabs([{ id: "1", label: "build" }, { id: "2", label: "explore" }], "1");
			shell.setFooter({
				cwd: "/home/oscar/project",
				branch: "main",
				model: "opencode/deepseek",
				context: "12%",
				tokens: "12.3k in · 1.2k out",
				tps: "38 t/s",
				cost: "$0.01",
			});
			shell.setTranscriptPlaceholder(
				'user\n  refactor the auth flow\n\nassistant\n  I\'ll inspect the current implementation.\n\n  bash  $ rg "auth" src\n  src/auth.ts:42 ...',
			);
			await setup.renderOnce();
			const expected = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), "utf8");
			assert.equal(setup.captureCharFrame(), expected);
		} finally {
			shell.dispose();
			await setup.dispose();
		}
	}
});

test("io shell scrolls the transcript from test-renderer mouse input", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const setup = await createTestRenderer({ width: 80, height: 16 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	try {
		shell.setTranscriptPlaceholder(Array.from({ length: 80 }, (_, index) => `line ${index}`).join("\n"));
		await setup.renderOnce();
		const before = shell.transcriptContainer.scrollTop;
		await setup.mockMouse.scroll(10, 8, "up");
		await setup.flush();
		assert.notEqual(shell.transcriptContainer.scrollTop, before);
	} finally {
		shell.dispose();
		await setup.dispose();
	}
});
