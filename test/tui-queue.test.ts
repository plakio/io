import assert from "node:assert/strict";
import test from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

test("io toasts stack, persist errors and dismiss individually", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");

	const setup = await createTestRenderer({ width: 100, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	try {
		const info = shell.toast("saved", "success", { durationMs: 0 });
		const error = shell.toast("provider failed", "error");
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /saved/);
		assert.match(frame, /provider failed/);
		assert.match(frame, /✔/);
		assert.match(frame, /✖/);
		assert.match(frame, /Ask io/);

		shell.dismissToast(info);
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /saved/);
		assert.match(setup.captureCharFrame(), /provider failed/);

		shell.clearToasts();
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /provider failed/);
		assert.ok(error.length > 0);
	} finally {
		shell.dispose();
		await setup.dispose();
	}
});

test("io queue manager edits, deletes, reorders and steers prompts", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoQueueManager } = await import("../src/tui/next/queue-manager.js");

	const setup = await createTestRenderer({ width: 100, height: 28 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	const changes: string[][] = [];
	const steered: string[] = [];
	const queue = new IoQueueManager({
		renderer: setup.renderer,
		shell,
		queue: ["first", "second", "third"],
		onChange: (next) => changes.push([...next]),
		onSteer: (prompt) => {
			steered.push(prompt);
		},
	});

	try {
		queue.open();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Queued prompts/);
		assert.match(frame, /first/);
		assert.match(frame, /third/);

		queue.move(1);
		assert.equal(queue.selectedPrompt, "second");
		assert.equal(queue.startEdit(), true);
		assert.equal(queue.commitEdit("second edited"), true);
		assert.deepEqual(queue.queued, ["first", "second edited", "third"]);

		queue.move(-1);
		assert.equal(queue.moveSelected(1), true);
		assert.deepEqual(queue.queued, ["second edited", "first", "third"]);
		assert.equal(queue.deleteSelected(), true);
		assert.deepEqual(queue.queued, ["second edited", "third"]);
		assert.equal(queue.selectedPrompt, "third");
		assert.equal(await queue.steerSelected(), true);
		assert.deepEqual(queue.queued, ["second edited"]);
		assert.deepEqual(steered, ["third"]);
		assert.ok(changes.length >= 3);
	} finally {
		queue.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
