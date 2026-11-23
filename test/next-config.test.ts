import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, resolvePaths } from "../src/config.js";
import { configEdit, configSet, configShow } from "../src/commands/next-config.js";
import type { AgentEngine, EngineModel } from "../src/engine/types.js";

const models: EngineModel[] = [
	{
		provider: "opencode",
		id: "model-a",
		name: "Model A",
		contextWindow: 200_000,
		maxTokens: 32_000,
		reasoning: true,
		variants: [],
		input: ["text"],
		output: ["text"],
	},
];
const engine = { listModels: async () => models } as unknown as AgentEngine;

test("next config show, set and edit work without Pi", async () => {
	const root = mkdtempSync(join(tmpdir(), "io-next-config-"));
	const paths = resolvePaths({ IO_CONFIG_DIR: join(root, "config"), IO_DATA_DIR: join(root, "data") });
	let output = "";
	const io = { stdout: (text: string) => { output += text; }, stderr: () => {} };
	try {
		configShow(paths, io);
		assert.match(output, /theme\s+io/);

		await configSet(paths, engine, "theme", "dark", io);
		await configSet(paths, engine, "tps", "off", io);
		await configSet(paths, engine, "model", "opencode/model-a", io);
		const config = loadConfig(paths).config;
		assert.equal(config.appearance?.theme, "dark");
		assert.equal(config.appearance?.tps, false);
		assert.equal(config.provider, "opencode");
		assert.equal(config.model, "model-a");

		const prompt = {
			select: async (message: string) => (message.includes("provider") ? "opencode" : "model-a"),
		};
		await configEdit(paths, engine, prompt, io);
		assert.equal(loadConfig(paths).config.model, "model-a");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
