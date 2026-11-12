import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	modelReference,
	parseModelReference,
	selectModel,
} from "../src/providers.js";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	} as unknown as Model<Api>;
}

const models = [model("opencode-go", "alpha"), model("opencode-go", "beta"), model("openai-codex", "gamma")];

test("model references round-trip", () => {
	assert.equal(modelReference(models[0] as Model<Api>), "opencode-go/alpha");
	assert.deepEqual(parseModelReference("openai-codex/gamma"), { provider: "openai-codex", model: "gamma" });
	assert.deepEqual(parseModelReference("alpha"), { model: "alpha" });
});

test("preferred provider and model are selected", () => {
	const result = selectModel(models, { provider: "opencode-go", model: "beta" });
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.selection.model.id, "beta");
});

test("missing preferred model falls back with a warning", () => {
	const result = selectModel(models, { provider: "opencode-go", model: "missing" });
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.selection.model.id, "alpha");
		assert.match(result.selection.warning ?? "", /not available/);
	}
});

test("explicit model references select exactly", () => {
	const result = selectModel(models, {}, { modelRef: "openai-codex/gamma" });
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.selection.model.id, "gamma");

	const bad = selectModel(models, {}, { modelRef: "openai-codex/alpha" });
	assert.equal(bad.ok, false);
	if (!bad.ok) assert.match(bad.error, /not available/);
});

test("provider restriction works and reports unknown providers", () => {
	const result = selectModel(models, {}, { provider: "openai-codex" });
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.selection.model.id, "gamma");

	const unknown = selectModel(models, {}, { provider: "anthropic" });
	assert.equal(unknown.ok, false);
	if (!unknown.ok) assert.match(unknown.error, /Unknown provider/);
});

test("unsupported configured provider falls back with a warning", () => {
	const result = selectModel(models, { provider: "anthropic", model: "x" });
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.selection.model.id, "alpha");
		assert.match(result.selection.warning ?? "", /not supported/);
	}
});

test("no models produces an authentication error", () => {
	const result = selectModel([], {});
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /No models are available/);
});

test("models.json providers are selectable when known", () => {
	const custom = [...models, model("50x", "deepseek-ai/DeepSeek-V4.1-Flash-1017")];

	const byProvider = selectModel(custom, {}, { provider: "50x", knownProviders: ["50x"] });
	assert.equal(byProvider.ok, true);
	if (byProvider.ok) {
		assert.equal(byProvider.selection.model.provider, "50x");
		assert.equal(byProvider.selection.model.id, "deepseek-ai/DeepSeek-V4.1-Flash-1017");
	}

	const byReference = selectModel(custom, {}, {
		modelRef: "50x/deepseek-ai/DeepSeek-V4.1-Flash-1017",
		knownProviders: ["50x"],
	});
	assert.equal(byReference.ok, true);
	if (byReference.ok) assert.equal(byReference.selection.model.provider, "50x");

	const asPreference = selectModel(custom, {
		provider: "50x",
		model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
	}, { knownProviders: ["50x"] });
	assert.equal(asPreference.ok, true);
	if (asPreference.ok) assert.equal(asPreference.selection.model.provider, "50x");
});

test("unknown providers list the configured models.json providers", () => {
	const result = selectModel(models, {}, { provider: "anthropic", knownProviders: ["50x"] });
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /Configured providers: .*50x/);
});
