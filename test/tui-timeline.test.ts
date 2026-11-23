import assert from "node:assert/strict";
import test from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

test("io timeline lists user messages and jumps to the selected one", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoTimeline } = await import("../src/tui/next/timeline.js");

	const setup = await createTestRenderer({ width: 100, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	let selected: number | undefined;
	let closed = 0;
	const timeline = new IoTimeline({
		renderer: setup.renderer,
		shell,
		entries: ["refactor the auth flow", "add oauth login", "fix the tests"],
		onSelect: (index) => {
			selected = index;
		},
		onClose: () => {
			closed += 1;
		},
	});

	try {
		timeline.open();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Timeline/);
		assert.match(frame, /refactor the auth flow/);
		assert.match(frame, /fix the tests/);
		assert.equal(timeline.selectedIndex, 2);

		timeline.move(-1);
		assert.equal(timeline.selectedIndex, 1);
		assert.equal(timeline.selectCurrent(), true);
		assert.equal(selected, 1);
		assert.equal(timeline.isOpen, false);
		assert.equal(closed, 1);
	} finally {
		timeline.dispose();
		shell.dispose();
		await setup.dispose();
	}
});

test("io transcript exposes user messages for the timeline", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoTranscript } = await import("../src/tui/next/transcript.js");

	const setup = await createTestRenderer({ width: 100, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	const transcript = new IoTranscript({ renderer: setup.renderer, container: shell.transcriptContainer });
	try {
		transcript.addUser("first");
		transcript.addUser("second");
		assert.deepEqual(transcript.userMessages, ["first", "second"]);
		assert.equal(transcript.focusUserMessage(0), true);
		assert.equal(transcript.focusUserMessage(5), false);
		transcript.clear();
		assert.deepEqual(transcript.userMessages, []);
	} finally {
		transcript.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
