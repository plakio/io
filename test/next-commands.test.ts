import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEngine, EngineModel } from "../src/engine/types.js";
import { listModels, listSessions, modelLines, sessionLines } from "../src/commands/next.js";

const models: EngineModel[] = [
	{
		provider: "opencode",
		id: "model-a",
		name: "Model A",
		contextWindow: 200_000,
		maxTokens: 32_000,
		reasoning: true,
		variants: ["low", "high"],
		input: ["text"],
		output: ["text"],
		cost: { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0.1 },
	},
	{
		provider: "other",
		id: "model-b",
		name: "Model B",
		contextWindow: 128_000,
		maxTokens: 16_000,
		reasoning: false,
		variants: [],
		input: ["text"],
		output: ["text"],
	},
];

test("next command formatting and filtering", async () => {
	assert.match(modelLines(models)[0] ?? "", /opencode\/model-a/);
	assert.match(modelLines(models)[0] ?? "", /variants low,high/);
	assert.match(modelLines(models)[0] ?? "", /\$0\.50\/\$1\.50/);
	assert.match(sessionLines([{ id: "ses_1", title: "Build", createdAt: 1, updatedAt: 2 }])[0] ?? "", /ses_1/);

	const engine = {
		listModels: async () => models,
		listSessions: async () => [{ id: "ses_1", title: "Build", createdAt: 1, updatedAt: 2 }],
	} as unknown as AgentEngine;
	assert.equal((await listModels(engine, "opencode")).length, 1);
	assert.equal((await listModels(engine)).length, 2);
	assert.equal((await listSessions(engine)).length, 1);
});
