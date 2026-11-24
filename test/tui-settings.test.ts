import assert from "node:assert/strict";
import test from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

test("io theme picker previews and applies themes", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoThemePicker } = await import("../src/tui/next/theme-picker.js");

	const setup = await createTestRenderer({ width: 100, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	const previews: string[] = [];
	let selected: string | undefined;
	const picker = new IoThemePicker({
		renderer: setup.renderer,
		shell,
		options: [
			{ id: "io", label: "io", description: "Dark" },
			{ id: "io-light", label: "io light", description: "Light" },
			{ id: "system", label: "System", description: "Follow terminal" },
		],
		current: "io",
		onPreview: (id) => previews.push(id),
		onSelect: (id) => {
			selected = id;
		},
	});

	try {
		picker.open();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Theme/);
		assert.match(frame, /io light/);
		assert.match(frame, /Follow terminal/);
		assert.deepEqual(previews, ["io"]);

		picker.move(1);
		assert.equal(picker.selectedOption?.id, "io-light");
		assert.deepEqual(previews, ["io", "io-light"]);
		assert.equal(picker.selectCurrent(), true);
		assert.equal(selected, "io-light");
		assert.equal(picker.isOpen, false);
	} finally {
		picker.dispose();
		shell.dispose();
		await setup.dispose();
	}
});

test("io settings panel cycles appearance rows", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoSettingsPanel } = await import("../src/tui/next/settings-panel.js");

	const setup = await createTestRenderer({ width: 100, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	const activated: string[] = [];
	const panel = new IoSettingsPanel({
		renderer: setup.renderer,
		shell,
		rows: [
			{ id: "theme", label: "Theme", value: "io" },
			{ id: "thinking", label: "Thinking", value: "hidden" },
		],
		onActivate: (id) => activated.push(id),
	});

	try {
		panel.open();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Settings/);
		assert.match(frame, /Theme\s+io/);
		assert.match(frame, /Thinking\s+hidden/);

		assert.equal(panel.activate(), true);
		panel.move(1);
		assert.equal(panel.selectedRow?.id, "thinking");
		assert.equal(panel.activate(), true);
		assert.deepEqual(activated, ["theme", "thinking"]);
		panel.setRows([{ id: "theme", label: "Theme", value: "light" }]);
		assert.equal(panel.selectedRow?.id, "theme");
		panel.close();
		assert.equal(panel.isOpen, false);
	} finally {
		panel.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
