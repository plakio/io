import assert from "node:assert/strict";
import test from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

test("io terminal pane spawns a PTY and closes with F12", { skip: !supported }, async () => {
	const { createTestRenderer, KeyCodes } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoTerminalPane } = await import("../src/tui/next/terminal-pane.js");

	const setup = await createTestRenderer({ width: 100, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	const writes: string[] = [];
	const resizes: Array<[number, number]> = [];
	let killed = 0;
	let closed = 0;
	let listener: ((data: string | Uint8Array) => void) | undefined;
	const pane = new IoTerminalPane({
		renderer: setup.renderer,
		shell,
		cwd: "/home/oscar/project",
		spawn: () => ({
			write: (data) => writes.push(String(data)),
			resize: (cols, rows) => resizes.push([cols, rows]),
			kill: () => {
				killed += 1;
			},
			onData: (next) => {
				listener = next;
			},
		}),
		onClose: () => {
			closed += 1;
		},
	});

	try {
		pane.open();
		await setup.renderOnce();
		assert.equal(pane.isOpen, true);
		assert.ok(listener);
		listener?.("hello from shell");
		await setup.renderOnce();

		setup.mockInput.pressKey(KeyCodes.F12);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(pane.isOpen, false);
		assert.equal(killed, 1);
		assert.equal(closed, 1);
	} finally {
		pane.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
