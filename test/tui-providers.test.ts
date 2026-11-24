import assert from "node:assert/strict";
import test from "node:test";
import type { EngineSkill } from "../src/engine/types.js";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

test("io MCP panel lists servers and reconnects", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoMcpPanel } = await import("../src/tui/next/mcp-panel.js");

	const setup = await createTestRenderer({ width: 100, height: 26 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	const events: string[] = [];
	let connected = false;
	const panel = new IoMcpPanel({
		renderer: setup.renderer,
		shell,
		load: async () => [
			{ name: "files", status: connected ? "connected" : "failed", title: "Files" },
			{ name: "browser", status: "connected", title: "Browser" },
		],
		onConnect: (server) => {
			events.push(`connect:${server.name}`);
			connected = true;
		},
		onDisconnect: (server) => {
			events.push(`disconnect:${server.name}`);
		},
	});

	try {
		await panel.open();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /MCP/);
		assert.match(frame, /Files/);
		assert.match(frame, /failed/);
		assert.match(frame, /Browser/);
		assert.match(frame, /connected/);

		await panel.connectSelected();
		assert.deepEqual(events, ["connect:files"]);
		panel.move(1);
		await panel.disconnectSelected();
		assert.deepEqual(events, ["connect:files", "disconnect:browser"]);
		panel.dispose();
	} finally {
		shell.dispose();
		await setup.dispose();
	}
});

const skills: readonly EngineSkill[] = [
	{ id: "effect", name: "effect", description: "Effect v4 patterns" },
	{ id: "tests", name: "tests", description: "Test style" },
];

test("io skills panel filters and activates skills", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoSkillsPanel } = await import("../src/tui/next/skills-panel.js");

	const setup = await createTestRenderer({ width: 100, height: 26 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	let selected: string | undefined;
	const panel = new IoSkillsPanel({
		renderer: setup.renderer,
		shell,
		skills,
		onSelect: (skill) => {
			selected = skill.id;
		},
	});

	try {
		panel.open();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Skills/);
		assert.match(frame, /Effect v4 patterns/);
		assert.match(frame, /Test style/);
		panel.move(1);
		assert.equal(panel.selectCurrent(), true);
		assert.equal(selected, "tests");
	} finally {
		panel.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
