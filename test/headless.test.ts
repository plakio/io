import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type Api, type Model } from "@earendil-works/pi-ai";
import { CliError } from "../src/errors.js";
import { runHeadless } from "../src/main.js";
import type { AvailableModels } from "../src/runtime.js";
import { createFauxHarness, temporaryPaths } from "./helpers.js";

function fauxModels(model: Model<Api>): AvailableModels {
	return {
		models: [model],
		errors: new Map(),
		providers: [model.provider],
		providerNames: new Map([[model.provider, model.provider]]),
	};
}

test("headless run streams text and prints stats", async () => {
	const temporary = temporaryPaths("io-headless-");
	const harness = await createFauxHarness({ paths: temporary.paths });
	let stdout = "";
	let stderr = "";
	try {
		const model = harness.faux.getModel();
		harness.faux.setResponses([fauxAssistantMessage("headless hello")]);
		const code = await runHeadless(
			{
				prompt: "say hello",
				continueSession: false,
				readStdin: false,
				savePreference: false,
				stats: true,
			},
			{
				paths: temporary.paths,
				runtime: harness.runtime,
				models: fauxModels(model),
				harness: harness.harness,
				stdout: (text) => {
					stdout += text;
				},
				stderr: (text) => {
					stderr += text;
				},
			},
		);
		assert.equal(code, 0);
		assert.match(stdout, /headless hello/);
		assert.match(stderr, /io stats: .* in .* out/);
	} finally {
		temporary.cleanup();
	}
});

test("headless fail-on-tool-error reports a failed command", async () => {
	const temporary = temporaryPaths("io-headless-fail-");
	const harness = await createFauxHarness({ paths: temporary.paths });
	let stdout = "";
	try {
		const model = harness.faux.getModel();
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "false" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("command failed"),
		]);
		const code = await runHeadless(
			{
				prompt: "run false",
				continueSession: false,
				readStdin: false,
				savePreference: false,
				failOnToolError: true,
			},
			{
				paths: temporary.paths,
				runtime: harness.runtime,
				models: fauxModels(model),
				harness: harness.harness,
				stdout: (text) => {
					stdout += text;
				},
			},
		);
		assert.equal(code, 1);
		assert.match(stdout, /command failed/);
	} finally {
		temporary.cleanup();
	}
});

test("headless streaming deltas are written incrementally", async () => {
	const temporary = temporaryPaths("io-headless-stream-");
	const harness = await createFauxHarness({ paths: temporary.paths, tokensPerSecond: 200 });
	let stdout = "";
	try {
		const model = harness.faux.getModel();
		harness.faux.setResponses([fauxAssistantMessage("streamed words here")]);
		const code = await runHeadless(
			{
				prompt: "stream",
				continueSession: false,
				readStdin: false,
				savePreference: false,
			},
			{
				paths: temporary.paths,
				runtime: harness.runtime,
				models: fauxModels(model),
				harness: harness.harness,
				stdout: (text) => {
					stdout += text;
				},
			},
		);
		assert.equal(code, 0);
		assert.match(stdout, /streamed words here/);
	} finally {
		temporary.cleanup();
	}
});

test("headless reports a provider error", async () => {
	const temporary = temporaryPaths("io-headless-error-");
	const harness = await createFauxHarness({ paths: temporary.paths });
	let stderr = "";
	try {
		const model = harness.faux.getModel();
		harness.faux.setResponses([
			fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "provider exploded" }),
		]);
		const code = await runHeadless(
			{
				prompt: "fail",
				continueSession: false,
				readStdin: false,
				savePreference: false,
			},
			{
				paths: temporary.paths,
				runtime: harness.runtime,
				models: fauxModels(model),
				harness: harness.harness,
				stderr: (text) => {
					stderr += text;
				},
			},
		);
		assert.equal(code, 1);
		assert.match(stderr, /provider exploded/);
	} finally {
		temporary.cleanup();
	}
});

test("headless persists the selected model unless --no-save is used", async () => {
	const temporary = temporaryPaths("io-headless-save-");
	const harness = await createFauxHarness({ paths: temporary.paths });
	try {
		const model = harness.faux.getModel();
		harness.faux.setResponses([fauxAssistantMessage("saved")]);
		const code = await runHeadless(
			{
				prompt: "save",
				continueSession: false,
				readStdin: false,
			},
			{
				paths: temporary.paths,
				runtime: harness.runtime,
				models: fauxModels(model),
				harness: harness.harness,
				stdout: () => {},
			},
		);
		assert.equal(code, 0);
		const saved = JSON.parse(readFileSync(temporary.paths.configPath, "utf8")) as {
			provider?: string;
			model?: string;
		};
		assert.equal(saved.provider, model.provider);
		assert.equal(saved.model, model.id);
	} finally {
		temporary.cleanup();
	}
});

test("headless validates prompt and model selection early", async () => {
	const temporary = temporaryPaths("io-headless-validation-");
	const harness = await createFauxHarness({ paths: temporary.paths });
	try {
		const model = harness.faux.getModel();
		await assert.rejects(
			runHeadless({ continueSession: false, readStdin: false }, { paths: temporary.paths }),
			(error: unknown) => error instanceof CliError && /usage:/.test(error.message),
		);
		await assert.rejects(
			runHeadless(
				{ prompt: "x", continueSession: false, readStdin: false },
				{ paths: temporary.paths, runtime: harness.runtime, models: { models: [], errors: new Map(), providers: [], providerNames: new Map() } },
			),
			(error: unknown) => error instanceof CliError && /No authenticated models/.test(error.message),
		);
		await assert.rejects(
			runHeadless(
				{ prompt: "x", continueSession: false, readStdin: false, modelRef: "missing/nope" },
				{ paths: temporary.paths, runtime: harness.runtime, models: fauxModels(model) },
			),
			(error: unknown) => error instanceof CliError && /not available/.test(error.message),
		);
	} finally {
		temporary.cleanup();
	}
});
