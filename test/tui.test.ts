import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ConfirmCommand } from "../src/session.js";
import { IoApp } from "../src/tui/app.js";
import { createFauxHarness, FakeTerminal, temporaryPaths, waitFor } from "./helpers.js";

function typeText(terminal: FakeTerminal, text: string): void {
	for (const char of text) terminal.feedInput(char);
}

function submitSlashCommand(terminal: FakeTerminal, command: string): void {
	typeText(terminal, command);
	// The first Enter accepts the slash-command autocomplete; the second submits.
	terminal.feedInput("\r");
	terminal.feedInput("\r");
}

test("TUI renders, handles /help, and exits cleanly", async () => {
	const harness = await createFauxHarness();
	const terminal = new FakeTerminal();
	const app = new IoApp({
		cwd: process.cwd(),
		paths: harness.paths,
		runtime: harness.runtime,
		harness: harness.harness,
		model: harness.faux.getModel(),
		config: {},
		terminal,
		backgroundRefresh: false,
	});
	try {
		const running = app.run();
		await waitFor(() => terminal.text.includes("type /help"), "initial render");
		submitSlashCommand(terminal, "/help");
		await waitFor(() => terminal.text.includes("Commands"), "help output");
		submitSlashCommand(terminal, "/quit");
		assert.equal(await running, 0);
		assert.equal(terminal.stopped, true);
	} finally {
		if (!terminal.stopped) app.shutdown(0);
		harness.cleanup();
	}
});

test("TUI approval defaults to deny and keeps the command blocked", async () => {
	const temporary = temporaryPaths("io-tui-approval-");
	const marker = mkdtempSync(join(tmpdir(), "io-tui-marker-"));
	writeFileSync(join(marker, "file.txt"), "x");
	let confirm: ConfirmCommand | undefined;
	const harness = await createFauxHarness({
		paths: temporary.paths,
		confirmCommand: async (request) => (confirm ? confirm(request) : false),
	});
	const terminal = new FakeTerminal();
	const app = new IoApp({
		cwd: process.cwd(),
		paths: temporary.paths,
		runtime: harness.runtime,
		harness: harness.harness,
		model: harness.faux.getModel(),
		config: {},
		terminal,
		backgroundRefresh: false,
	});
	confirm = app.getConfirmCommand();
	try {
		const running = app.run();
		await waitFor(() => terminal.text.includes("type /help"), "initial render");
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: `rm -rf ${marker}` }), { stopReason: "toolUse" }),
			fauxAssistantMessage("command was not run"),
		]);
		typeText(terminal, "delete the marker");
		terminal.feedInput("\r");
		await waitFor(() => terminal.text.includes("Run this command?"), "approval overlay");
		// The default selection is Deny; a bare Enter must not approve.
		terminal.feedInput("\r");
		await waitFor(() => terminal.text.includes("command was not run"), "final response");
		assert.equal(existsSync(marker), true);
		assert.match(terminal.text, /denied/i);
		submitSlashCommand(terminal, "/quit");
		assert.equal(await running, 0);
	} finally {
		if (!terminal.stopped) app.shutdown(0);
		harness.cleanup();
		temporary.cleanup();
		rmSync(marker, { recursive: true, force: true });
	}
});

test("TUI shutdown restores the terminal through exit()", async () => {
	const harness = await createFauxHarness();
	const terminal = new FakeTerminal();
	const app = new IoApp({
		cwd: process.cwd(),
		paths: harness.paths,
		runtime: harness.runtime,
		harness: harness.harness,
		model: harness.faux.getModel(),
		config: {},
		terminal,
		backgroundRefresh: false,
	});
	try {
		const running = app.run();
		await waitFor(() => terminal.text.includes("type /help"), "initial render");
		app.shutdown(143);
		assert.equal(await running, 143);
		assert.equal(terminal.stopped, true);
	} finally {
		if (!terminal.stopped) app.shutdown(0);
		harness.cleanup();
	}
});
