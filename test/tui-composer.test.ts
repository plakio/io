import assert from "node:assert/strict";
import test from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

test("io composer handles modes, history, completion, paste and queue", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoComposer } = await import("../src/tui/next/composer.js");

	const setup = await createTestRenderer({ width: 100, height: 30 });
	const shell = new IoShell(setup.renderer, {
		cwd: "/home/oscar/project",
		version: "0.2.0",
	});
	const submitted: Array<{ text: string; mode: string; delivery: string }> = [];
	const queueChanges: Array<readonly string[]> = [];
	const composer = new IoComposer({
		renderer: setup.renderer,
		textarea: shell.composer,
		onSubmit: (text, mode, delivery) => submitted.push({ text, mode, delivery }),
		onQueueChange: (queue) => queueChanges.push(queue),
	});

	try {
		assert.equal(composer.currentMode, "prompt");
		assert.match(String(composer.textarea.placeholder), /Ask io/);

		composer.setText("!ls");
		assert.equal(composer.currentMode, "shell");
		assert.match(String(composer.textarea.placeholder), /Shell command/);
		composer.setText("/model");
		assert.equal(composer.currentMode, "command");
		assert.match(String(composer.textarea.placeholder), /Command/);

		composer.setText("first prompt");
		assert.equal(composer.textarea.submit(), true);
		assert.equal(submitted.at(-1)?.text, "first prompt");
		assert.equal(composer.text, "");
		composer.setText("second prompt");
		assert.equal(composer.submit(), true);
		composer.setText("draft");
		assert.equal(composer.historyPrevious(), true);
		assert.equal(composer.text, "second prompt");
		assert.equal(composer.historyPrevious(), true);
		assert.equal(composer.text, "first prompt");
		assert.equal(composer.historyNext(), true);
		assert.equal(composer.text, "second prompt");
		assert.equal(composer.historyNext(), true);
		assert.equal(composer.text, "draft");
		assert.deepEqual(submitted.map((entry) => entry.text), ["first prompt", "second prompt"]);

		composer.setCompletions([
			{ value: "/model", description: "Select a model", kind: "command" },
			{ value: "/mode", description: "Set approval mode", kind: "command" },
			{ value: "src/tui", kind: "path" },
		]);
		composer.setText("/mo");
		assert.equal(composer.completion()?.value, "/model");
		assert.equal(composer.acceptCompletion(), true);
		assert.equal(composer.text, "/model ");
		composer.setText("src/t");
		assert.equal(composer.completion()?.value, "src/tui");
		assert.equal(composer.acceptCompletion(), true);
		assert.equal(composer.text, "src/tui ");

		composer.setText("!");
		const large = "x".repeat(10_000);
		composer.paste(large);
		const pasted = String(composer.text);
		assert.equal(pasted.length, 10_001);
		await setup.renderOnce();

		composer.clear();
		composer.setText("!echo hello");
		assert.equal(composer.submit(), true);
		assert.equal(submitted.at(-1)?.mode, "shell");

		composer.setText("queued one");
		assert.equal(composer.queue(), 1);
		composer.setText("queued two");
		assert.equal(composer.queue(), 2);
		assert.equal(composer.editQueued(0, "edited one"), true);
		assert.deepEqual(composer.queued, ["edited one", "queued two"]);
		assert.equal(composer.removeQueued(1), true);
		assert.deepEqual(composer.queued, ["edited one"]);
		composer.clearQueue();
		assert.deepEqual(composer.queued, []);
		assert.ok(queueChanges.length >= 4);

		composer.setText("steer now");
		assert.equal(composer.submit("steer"), true);
		assert.equal(submitted.at(-1)?.delivery, "steer");
		composer.setText("queue this");
		assert.equal(composer.submit("queue"), true);
		assert.equal(submitted.at(-1)?.delivery, "queue");
	} finally {
		composer.dispose();
		shell.dispose();
		await setup.dispose();
	}
});

test("io composer sends on Enter and keeps Shift+Enter for new lines", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoComposer } = await import("../src/tui/next/composer.js");

	// Shift+Enter is only distinguishable with the Kitty keyboard protocol.
	const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	const submitted: Array<{ text: string; mode: string }> = [];
	const composer = new IoComposer({
		renderer: setup.renderer,
		textarea: shell.composer,
		onSubmit: (text, mode) => submitted.push({ text, mode }),
	});

	try {
		await setup.mockInput.typeText("/help");
		await setup.renderOnce();
		assert.equal(composer.text, "/help");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		assert.deepEqual(submitted, [{ text: "/help", mode: "command" }]);
		assert.equal(composer.text, "");

		await setup.mockInput.typeText("line one");
		setup.mockInput.pressEnter({ shift: true });
		await setup.mockInput.typeText("line two");
		await setup.renderOnce();
		assert.equal(composer.text, "line one\nline two");
		assert.equal(submitted.length, 1);

		// Ctrl+J is the fallback newline when the terminal cannot report Shift+Enter.
		setup.mockInput.pressKey("j", { ctrl: true });
		await setup.renderOnce();
		assert.equal(composer.text, "line one\nline two\n");
		assert.equal(submitted.length, 1);
	} finally {
		composer.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
