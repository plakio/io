import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { IoApp } from "../src/tui/app.js";
import { createFauxHarness, FakeTerminal, temporaryPaths, waitFor } from "./helpers.js";

function typeText(terminal: FakeTerminal, text: string): void {
	for (const char of text) terminal.feedInput(char);
}

function submitCommand(terminal: FakeTerminal, command: string): void {
	typeText(terminal, command);
	terminal.feedInput("\r");
	terminal.feedInput("\r");
}

test("TUI slash commands cover state, diagnostics, export, and reload", async () => {
	const temporary = temporaryPaths("io-tui-commands-");
	const harness = await createFauxHarness({ paths: temporary.paths });
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
	try {
		const running = app.run();
		await waitFor(() => terminal.text.includes("type /help"), "initial render");

		const expects = async (command: string, needle: string) => {
			submitCommand(terminal, command);
			await waitFor(() => terminal.text.includes(needle), `${command} output`);
		};

		await expects("/agent", "agent: build");
		await expects("/session", "messages");
		await expects("/resume", "No sessions for this directory");
		await expects("/verbosity", "verbosity: normal");
		await expects("/verbosity high", "thinking visible, tools expanded");
		await expects("/verbosity low", "tool output hidden");
		await expects("/verbosity normal", "tools collapsed, thinking hidden");
		await expects("/mode", "permission mode: ask");
		await expects("/mode auto", "permission mode: auto");
		await expects("/permissions ask", "permission mode: ask");
		await expects("/name test-session", "session name: test-session");
		await expects("/copy", "nothing to copy yet");
		await expects("/login", "Authenticate in a separate terminal");
		await expects("/logout", "Remove credentials");
		await expects("/fork", "No user messages to fork from");
		await expects("/models", "No authenticated models");
		await expects("/model", "No authenticated models");
		await expects("/scope", "No authenticated models");
		await expects("/effort off", "effort");
		await expects("/diff", "diff");

		const exportPath = join(temporary.paths.dataDir, "export.jsonl");
		await expects(`/export jsonl ${exportPath}`, "exported session");
		assert.equal(existsSync(exportPath), true);

		await expects("/debug", "debug log:");
		assert.equal(existsSync(join(temporary.paths.dataDir, "io-debug.log")), true);

		writeFileSync(temporary.paths.configPath, "{not json");
		await expects("/reload", "reload skipped");

		await expects("/new", "switched session");
		await expects("/quit", "");

		assert.equal(await running, 0);
		assert.equal(terminal.stopped, true);
	} finally {
		if (!terminal.stopped) app.shutdown(0);
		harness.cleanup();
		temporary.cleanup();
	}
});
