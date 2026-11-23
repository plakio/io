import assert from "node:assert/strict";
import test from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

test("io error panel shows the full message and closes", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoErrorPanel } = await import("../src/tui/next/error-panel.js");

	const setup = await createTestRenderer({ width: 100, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	let closed = 0;
	const panel = new IoErrorPanel({
		renderer: setup.renderer,
		shell,
		onClose: () => {
			closed += 1;
		},
	});

	try {
		panel.open("Request failed: 401 Unauthorized\nprovider returned an invalid token");
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Error/);
		assert.match(frame, /Request failed: 401 Unauthorized/);
		assert.match(frame, /invalid token/);
		assert.equal(typeof panel.copy(), "boolean");

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
