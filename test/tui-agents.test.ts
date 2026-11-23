import assert from "node:assert/strict";
import test from "node:test";
import type { EngineAgent } from "../src/engine/types.js";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

const agents: readonly EngineAgent[] = [
	{ id: "build", name: "Build", mode: "primary", hidden: false, description: "The default agent." },
	{ id: "plan", name: "Plan", mode: "primary", hidden: false, description: "Plan before coding." },
	{ id: "general", name: "General", mode: "subagent", hidden: false },
	{ id: "explore", name: "Explore", mode: "subagent", hidden: false },
	{ id: "compaction", name: "Compaction", mode: "primary", hidden: true },
	{ id: "title", name: "Title", mode: "primary", hidden: true },
	{ id: "summary", name: "Summary", mode: "primary", hidden: true },
];

test("io agent picker lists primary agents and hides subagents and maintenance agents", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoAgentPicker, selectableAgents } = await import("../src/tui/next/agent-picker.js");

	const setup = await createTestRenderer({ width: 100, height: 28 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	let selected: EngineAgent | undefined;
	let closed = 0;
	const picker = new IoAgentPicker({
		renderer: setup.renderer,
		shell,
		agents,
		current: "build",
		onSelect: (agent) => {
			selected = agent;
		},
		onClose: () => {
			closed += 1;
		},
	});

	try {
		assert.deepEqual(selectableAgents(agents).map((agent) => agent.id), ["build", "plan"]);

		picker.open();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Agents/);
		assert.match(frame, /Build/);
		assert.match(frame, /Plan/);
		assert.doesNotMatch(frame, /General/);
		assert.doesNotMatch(frame, /Explore/);
		assert.doesNotMatch(frame, /Compaction/);
		assert.doesNotMatch(frame, /Title/);
		assert.doesNotMatch(frame, /Summary/);

		picker.move(1);
		assert.equal(picker.selectedAgent?.id, "plan");
		assert.equal(picker.selectCurrent(), true);
		assert.equal(selected?.id, "plan");
		assert.equal(picker.isOpen, false);
		assert.equal(closed, 1);
	} finally {
		picker.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
