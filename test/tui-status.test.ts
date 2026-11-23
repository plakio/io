import assert from "node:assert/strict";
import test from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

test("io status panel renders session state and refreshes", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoStatusPanel } = await import("../src/tui/next/status-panel.js");

	const setup = await createTestRenderer({ width: 100, height: 28 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	let loads = 0;
	let closed = 0;
	const panel = new IoStatusPanel({
		renderer: setup.renderer,
		shell,
		load: async () => {
			loads += 1;
			return ["Version    io 0.2.2 · opencode", "Agent      Build", "Model      openai/gpt-5", "Effort     high", "Context    12.5%"];
		},
		onClose: () => {
			closed += 1;
		},
	});

	try {
		await panel.open();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Status/);
		assert.match(frame, /io 0\.2\.2 · opencode/);
		assert.match(frame, /Agent {6}Build/);
		assert.match(frame, /Effort {5}high/);
		setup.mockInput.pressKey("r");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(loads, 2);
		setup.mockInput.pressEscape();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(panel.isOpen, false);
		assert.equal(closed, 1);
	} finally {
		panel.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
