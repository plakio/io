import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePaths } from "../src/config.js";
import { syncModelsConfig } from "../src/engine/models-config.js";

test("models.json converts to OpenCode provider config", () => {
	const root = mkdtempSync(join(tmpdir(), "io-models-config-"));
	const paths = resolvePaths({ IO_CONFIG_DIR: join(root, "config"), IO_DATA_DIR: join(root, "data") });
	mkdirSync(paths.dataDir, { recursive: true });
	mkdirSync(join(paths.configDir, "opencode"), { recursive: true });
	writeFileSync(
		paths.modelsPath,
		JSON.stringify({
			providers: {
				"50x": {
					name: "50x",
					baseUrl: "https://api.ai.50x.energy/v1",
					api: "openai-completions",
					apiKey: "$FIFTYX_API_KEY",
					models: [
						{
							id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
							name: "DeepSeek V4.1 Flash",
							reasoning: true,
							contextWindow: 1_000_000,
							maxTokens: 384_000,
						},
					],
				},
			},
		}),
	);
	writeFileSync(join(paths.configDir, "opencode", "opencode.json"), JSON.stringify({ theme: { keep: true } }));
	const result = syncModelsConfig(paths);
	assert.equal(result.providers, 1);
	assert.equal(result.warnings.length, 0);
	const config = JSON.parse(readFileSync(join(paths.configDir, "opencode", "opencode.json"), "utf8"));
	assert.deepEqual(config.theme, { keep: true });
	assert.equal(config.providers["50x"].package, "@opencode/ai/providers/openai-compatible");
	assert.deepEqual(config.providers["50x"].env, ["FIFTYX_API_KEY"]);
	assert.equal(config.providers["50x"].settings.baseURL, "https://api.ai.50x.energy/v1");
	const model = config.providers["50x"].models["deepseek-ai/DeepSeek-V4.1-Flash-1017"];
	assert.equal(model.limit.context, 1_000_000);
	assert.equal(model.limit.output, 384_000);
	assert.equal(model.capabilities.reasoning.supported, true);
});
