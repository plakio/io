import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { type Api, type Model } from "@earendil-works/pi-ai";
import { CliError } from "../src/errors.js";
import { runInteractive } from "../src/main.js";
import type { AvailableModels } from "../src/runtime.js";
import { createFauxHarness, FakeTerminal, temporaryPaths, waitFor } from "./helpers.js";

function fauxModels(model: Model<Api>): AvailableModels {
	return {
		models: [model],
		errors: new Map(),
		providers: [model.provider],
		providerNames: new Map([[model.provider, model.provider]]),
	};
}

function typeText(terminal: FakeTerminal, text: string): void {
	for (const char of text) terminal.feedInput(char);
}

function quit(terminal: FakeTerminal): void {
	typeText(terminal, "/quit");
	terminal.feedInput("\r");
	terminal.feedInput("\r");
}

test("runInteractive starts the TUI with injected dependencies", async () => {
	const temporary = temporaryPaths("io-run-interactive-");
	const harness = await createFauxHarness({ paths: temporary.paths });
	const terminal = new FakeTerminal();
	try {
		const running = runInteractive(
			{ continueSession: false },
			{
				paths: temporary.paths,
				runtime: harness.runtime,
				models: fauxModels(harness.faux.getModel()),
				harness: harness.harness,
				terminal,
				backgroundRefresh: false,
			},
		);
		await waitFor(() => terminal.text.includes("type /help"), "interactive render");
		quit(terminal);
		assert.equal(await running, 0);
		assert.equal(terminal.stopped, true);
	} finally {
		if (!terminal.stopped) harness.harness.session.dispose();
		temporary.cleanup();
	}
});

test("runInteractive reports missing models", async () => {
	const temporary = temporaryPaths("io-run-interactive-empty-");
	const harness = await createFauxHarness({ paths: temporary.paths });
	try {
		await assert.rejects(
			runInteractive(
				{ continueSession: false },
				{
					paths: temporary.paths,
					runtime: harness.runtime,
					models: { models: [], errors: new Map(), providers: [], providerNames: new Map() },
				},
			),
			(error: unknown) => error instanceof CliError && /No authenticated models/.test(error.message),
		);
	} finally {
		temporary.cleanup();
	}
});

test("runInteractive reports an invalid model reference", async () => {
	const temporary = temporaryPaths("io-run-interactive-model-");
	const harness = await createFauxHarness({ paths: temporary.paths });
	try {
		await assert.rejects(
			runInteractive(
				{ continueSession: false, modelRef: "missing/provider-model" },
				{
					paths: temporary.paths,
					runtime: harness.runtime,
					models: fauxModels(harness.faux.getModel()),
				},
			),
			(error: unknown) => error instanceof CliError && /not available/.test(error.message),
		);
	} finally {
		temporary.cleanup();
	}
});

test("runInteractive surfaces config warnings in the transcript", async () => {
	const temporary = temporaryPaths("io-run-interactive-warning-");
	const harness = await createFauxHarness({ paths: temporary.paths });
	const terminal = new FakeTerminal();
	try {
		writeFileSync(temporary.paths.configPath, "{not json");
		const running = runInteractive(
			{ continueSession: false },
			{
				paths: temporary.paths,
				runtime: harness.runtime,
				models: fauxModels(harness.faux.getModel()),
				harness: harness.harness,
				terminal,
				backgroundRefresh: false,
			},
		);
		await waitFor(() => terminal.text.includes("could not parse"), "config warning");
		quit(terminal);
		assert.equal(await running, 0);
	} finally {
		if (!terminal.stopped) harness.harness.session.dispose();
		temporary.cleanup();
	}
});
