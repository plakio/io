import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, type Api, type Model } from "@earendil-works/pi-ai";
import { IoApp } from "../src/tui/app.js";
import type { AvailableModels } from "../src/runtime.js";
import { createFauxHarness, FakeTerminal, waitFor } from "./helpers.js";

function typeText(terminal: FakeTerminal, text: string): void {
	for (const char of text) terminal.feedInput(char);
}

function submitCommand(terminal: FakeTerminal, command: string): void {
	typeText(terminal, command);
	terminal.feedInput("\r");
	terminal.feedInput("\r");
}

function modelsFor(model: Model<Api>): AvailableModels {
	const second = { ...model, id: `${model.id}-two`, name: "Faux Two" } as Model<Api>;
	return {
		models: [model, second],
		errors: new Map(),
		providers: [model.provider],
		providerNames: new Map([[model.provider, model.provider]]),
	};
}

test("TUI model picker opens with an injected catalog", async () => {
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
		availableModels: async () => modelsFor(harness.faux.getModel()),
	});
	try {
		const running = app.run();
		await waitFor(() => terminal.text.includes("type /help"), "initial render");
		submitCommand(terminal, "/model");
		await waitFor(() => terminal.text.includes("faux-1-two"), "model picker");
		app.shutdown(0);
		assert.equal(await running, 0);
		assert.equal(terminal.stopped, true);
	} finally {
		if (!terminal.stopped) app.shutdown(0);
		harness.cleanup();
	}
});

test("TUI scope picker opens with an injected catalog", async () => {
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
		availableModels: async () => modelsFor(harness.faux.getModel()),
	});
	try {
		const running = app.run();
		await waitFor(() => terminal.text.includes("type /help"), "initial render");
		submitCommand(terminal, "/scope");
		await waitFor(() => terminal.text.includes("faux-1-two"), "scope picker");
		app.shutdown(0);
		assert.equal(await running, 0);
	} finally {
		if (!terminal.stopped) app.shutdown(0);
		harness.cleanup();
	}
});

test("TUI keyboard shortcuts", async () => {
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
		availableModels: async () => modelsFor(harness.faux.getModel()),
	});
	try {
		const running = app.run();
		await waitFor(() => terminal.text.includes("type /help"), "initial render");

		terminal.feedInput("\x10");
		await waitFor(() => terminal.text.includes("faux-1-two"), "model cycle");

		terminal.feedInput("\x0f");
		await waitFor(() => /tool output expanded/i.test(terminal.text), "tool expansion");
		terminal.feedInput("\x0f");
		await waitFor(() => /tool output collapsed/i.test(terminal.text), "tool collapse");

		terminal.feedInput("\x14");
		await waitFor(() => /thinking shown/i.test(terminal.text), "thinking shown");
		terminal.feedInput("\x14");
		await waitFor(() => /thinking hidden/i.test(terminal.text), "thinking hidden");

		submitCommand(terminal, "/quit");
		assert.equal(await running, 0);
	} finally {
		if (!terminal.stopped) app.shutdown(0);
		harness.cleanup();
	}
});

test("TUI opens the external editor", async () => {
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
	const originalEditor = process.env.EDITOR;
	try {
		process.env.EDITOR = process.execPath;
		const running = app.run();
		await waitFor(() => terminal.text.includes("type /help"), "initial render");
		terminal.feedInput("\x07");
		await waitFor(() => terminal.text.includes("editor buffer updated"), "external editor");
		submitCommand(terminal, "/quit");
		assert.equal(await running, 0);
	} finally {
		if (originalEditor === undefined) delete process.env.EDITOR;
		else process.env.EDITOR = originalEditor;
		if (!terminal.stopped) app.shutdown(0);
		harness.cleanup();
	}
});

test("TUI checks for updates and compacts", async () => {
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
	const originalFetch = globalThis.fetch;
	try {
		const running = app.run();
		await waitFor(() => terminal.text.includes("type /help"), "initial render");
		globalThis.fetch = (async () => ({
			ok: true,
			status: 200,
			json: async () => ({ tag_name: "v99.0.0" }),
		})) as unknown as typeof fetch;
		submitCommand(terminal, "/update");
		await waitFor(() => terminal.text.includes("not Homebrew-managed"), "update check");

		harness.faux.setResponses([fauxAssistantMessage("compacted summary")]);
		submitCommand(terminal, "/compact");
		await waitFor(
			() =>
				terminal.text.includes("context compacted") ||
				terminal.text.includes("could not compact"),
			"compact result",
		);

		submitCommand(terminal, "/quit");
		assert.equal(await running, 0);
	} finally {
		globalThis.fetch = originalFetch;
		if (!terminal.stopped) app.shutdown(0);
		harness.cleanup();
	}
});

test("TUI forks from a previous user message", async () => {
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
		harness.faux.setResponses([fauxAssistantMessage("fork source answer")]);
		typeText(terminal, "hello fork");
		terminal.feedInput("\r");
		await waitFor(() => terminal.text.includes("fork source answer"), "first response");
		submitCommand(terminal, "/fork");
		await waitFor(() => terminal.text.includes("forked from message"), "fork");
		app.shutdown(0);
		assert.equal(await running, 0);
	} finally {
		if (!terminal.stopped) app.shutdown(0);
		harness.cleanup();
	}
});
