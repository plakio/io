import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import test from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nP8AAAAASUVORK5CYII=",
	"base64",
);

test("io image panel opens and closes a preview", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoImagePanel } = await import("../src/tui/next/image-panel.js");

	const target = "/tmp/io-image-test.png";
	writeFileSync(target, PNG);
	const setup = await createTestRenderer({ width: 100, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	let closed = 0;
	const panel = new IoImagePanel({
		renderer: setup.renderer,
		shell,
		onClose: () => {
			closed += 1;
		},
	});
	try {
		panel.open(target);
		await setup.renderOnce();
		assert.equal(panel.isOpen, true);
		assert.match(setup.captureCharFrame(), /Preview · io-image-test\.png/);
		setup.mockInput.pressEscape();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(panel.isOpen, false);
		assert.equal(closed, 1);
	} finally {
		panel.dispose();
		shell.dispose();
		await setup.dispose();
		try {
			unlinkSync(target);
		} catch {
			// Ignore cleanup.
		}
	}
});
