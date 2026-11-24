import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { CliRenderer } from "@opentui/core";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

function fakeRenderer(): CliRenderer {
	return { keyInput: new EventEmitter(), requestRender: () => {} } as unknown as CliRenderer;
}

test("io keymap resolves OpenCode bindings and leader sequences", { skip: !supported }, async () => {
	const { IoKeymap } = await import("../src/tui/next/keymap.js");
	const hits: string[] = [];
	const commands = [
		{ id: "palette", title: "Commands", keys: ["ctrl+p"], run: () => { hits.push("palette"); } },
		{ id: "models", title: "Models", keys: ["<leader>m"], run: () => { hits.push("models"); } },
		{ id: "queue", title: "Queue", keys: ["<leader>return"], run: () => { hits.push("queue"); } },
		{ id: "tps", title: "TPS", keys: ["<leader>p"], run: () => { hits.push("tps"); } },
	];
	const keymap = new IoKeymap({ renderer: fakeRenderer(), commands });
	try {
		assert.equal(keymap.handleKey({ name: "p", ctrl: true }), true);
		assert.equal(keymap.handleKey({ name: "m", ctrl: true }), false);
		assert.deepEqual(hits, ["palette"]);

		assert.equal(keymap.handleKey({ name: "x", ctrl: true }), true);
		assert.equal(keymap.isLeaderPending, true);
		assert.equal(keymap.handleKey({ name: "m" }), true);
		assert.equal(keymap.isLeaderPending, false);
		assert.equal(keymap.handleKey({ name: "x", ctrl: true }), true);
		assert.equal(keymap.handleKey({ name: "return" }), true);
		assert.equal(keymap.handleKey({ name: "x", ctrl: true }), true);
		assert.equal(keymap.handleKey({ name: "p" }), true);
		assert.deepEqual(hits, ["palette", "models", "queue", "tps"]);

		keymap.setSuspended(true);
		assert.equal(keymap.handleKey({ name: "p", ctrl: true }), false);
		keymap.setSuspended(false);
	} finally {
		keymap.dispose();
	}
});

test("io keymap shows and hides the which-key panel", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoKeymap } = await import("../src/tui/next/keymap.js");

	const setup = await createTestRenderer({ width: 100, height: 30 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	const keymap = new IoKeymap({
		renderer: setup.renderer,
		shell,
		commands: [
			{ id: "models", title: "Model picker", keys: ["<leader>m"], run: () => {} },
			{ id: "diff", title: "Diff viewer", keys: ["<leader>d"], run: () => {} },
		],
	});
	try {
		keymap.handleKey({ name: "x", ctrl: true });
		await setup.renderOnce();
		const leader = setup.captureCharFrame();
		assert.match(leader, /Leader/);
		assert.match(leader, /Model picker/);
		assert.match(leader, /Diff viewer/);

		keymap.handleKey({ name: "m" });
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /Model picker/);
	} finally {
		keymap.dispose();
		shell.dispose();
		await setup.dispose();
	}
});

test("io command palette filters and runs commands", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoCommandPalette } = await import("../src/tui/next/command-palette.js");

	const setup = await createTestRenderer({ width: 100, height: 30 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	const hits: string[] = [];
	let closed = 0;
	const palette = new IoCommandPalette({
		renderer: setup.renderer,
		shell,
		commands: [
			{
				id: "model",
				title: "Model picker",
				description: "Select a model",
				group: "Model",
				suggested: true,
				keys: ["<leader>m"],
				run: () => {
					hits.push("model");
				},
			},
			{
				id: "session",
				title: "Session list",
				description: "Resume a session",
				group: "Session",
				keys: ["<leader>l"],
				run: () => {
					hits.push("session");
				},
			},
			{ id: "tps", title: "Toggle TPS", description: "Show tokens per second", group: "View", run: () => { hits.push("tps"); } },
		],
		onClose: () => {
			closed += 1;
		},
	});
	try {
		palette.open();
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /Commands/);
		assert.match(setup.captureCharFrame(), /Suggested/);
		assert.match(setup.captureCharFrame(), /Model picker/);
		assert.match(setup.captureCharFrame(), /ctrl\+x m/);

		palette.setQuery("session");
		await setup.renderOnce();
		assert.equal(palette.selectedCommand?.id, "session");
		assert.equal(palette.executeSelected(), true);
		assert.deepEqual(hits, ["session"]);
		assert.equal(palette.isOpen, false);
		assert.equal(closed, 1);
	} finally {
		palette.dispose();
		shell.dispose();
		await setup.dispose();
	}
});

test("io default bindings include the OpenCode-first keymap", { skip: !supported }, async () => {
	const { DEFAULT_KEYBINDINGS, createIoCommands } = await import("../src/tui/next/commands.js");
	const { IoKeymap } = await import("../src/tui/next/keymap.js");
	assert.deepEqual(DEFAULT_KEYBINDINGS["model.list"], ["<leader>m"]);
	assert.deepEqual(DEFAULT_KEYBINDINGS["command.palette.show"], ["ctrl+p"]);
	assert.deepEqual(DEFAULT_KEYBINDINGS["diff.open"], ["<leader>d"]);
	const hits: string[] = [];
	const keymap = new IoKeymap({
		renderer: fakeRenderer(),
		commands: createIoCommands({ "model.list": () => { hits.push("model"); } }),
	});
	try {
		keymap.handleKey({ name: "p", ctrl: true });
		keymap.handleKey({ name: "x", ctrl: true });
		keymap.handleKey({ name: "m" });
		assert.deepEqual(hits, ["model"]);
	} finally {
		keymap.dispose();
	}
});

test("io keymap consumes real test-renderer key events", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoKeymap } = await import("../src/tui/next/keymap.js");
	const setup = await createTestRenderer({ width: 80, height: 20 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	let hits = 0;
	const keymap = new IoKeymap({
		renderer: setup.renderer,
		shell,
		commands: [{ id: "palette", title: "Palette", keys: ["ctrl+p"], run: () => { hits += 1; } }],
	});
	try {
		setup.mockInput.pressKey("p", { ctrl: true });
		await setup.flush();
		assert.equal(hits, 1);
	} finally {
		keymap.dispose();
		shell.dispose();
		await setup.dispose();
	}
});

test("io command palette rows respond to mouse clicks", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoCommandPalette } = await import("../src/tui/next/command-palette.js");

	const setup = await createTestRenderer({ width: 100, height: 30 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	const hits: string[] = [];
	const palette = new IoCommandPalette({
		renderer: setup.renderer,
		shell,
		commands: [
			{ id: "one", title: "First", description: "One", run: () => { hits.push("one"); } },
			{ id: "two", title: "Second", description: "Two", run: () => { hits.push("two"); } },
		],
	});
	try {
		palette.open();
		await setup.renderOnce();
		const row = setup.renderer.root.findDescendantById("palette-1");
		assert.ok(row);
		await setup.mockMouse.click(row.screenX + 1, row.screenY);
		assert.deepEqual(hits, ["two"]);
		assert.equal(palette.isOpen, false);
	} finally {
		palette.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
