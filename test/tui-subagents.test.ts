import assert from "node:assert/strict";
import test from "node:test";
import type { EngineSessionSummary } from "../src/engine/types.js";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

const sessions: readonly EngineSessionSummary[] = [
	{ id: "ses_child1", title: "Search auth", parentID: "ses_parent", agent: "explore", busy: true, createdAt: 1, updatedAt: 2 },
	{ id: "ses_child2", title: "Review tests", parentID: "ses_parent", agent: "general", busy: false, createdAt: 1, updatedAt: 3 },
];

test("io subagent picker lists child sessions with agent and state", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoSubagentPicker } = await import("../src/tui/next/subagent-picker.js");

	const setup = await createTestRenderer({ width: 100, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	let selected: string | undefined;
	let closed = 0;
	const picker = new IoSubagentPicker({
		renderer: setup.renderer,
		shell,
		sessions,
		onSelect: (session) => {
			selected = session.id;
		},
		onClose: () => {
			closed += 1;
		},
	});

	try {
		picker.open();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Subagents/);
		assert.match(frame, /Search auth/);
		assert.match(frame, /explore/);
		assert.match(frame, /working/);
		assert.match(frame, /Review tests/);
		assert.match(frame, /general/);

		picker.move(1);
		assert.equal(picker.selectedSession?.id, "ses_child2");
		assert.equal(picker.selectCurrent(), true);
		assert.equal(selected, "ses_child2");
		assert.equal(picker.isOpen, false);
		assert.equal(closed, 1);
	} finally {
		picker.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
