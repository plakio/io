import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolvePaths } from "../src/config.js";
import {
	createIoModelRuntime,
	knownProviderIds,
	loadAvailableModels,
	readConfiguredProviderIds,
	readProviderEnvNames,
	refreshCatalogs,
	reloadModelsJson,
	restoreCatalogs,
} from "../src/runtime.js";

function tempRoot(): string {
	const root = join(tmpdir(), `io-runtime-${process.pid}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return root;
}

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

function writeModelsFile(path: string, providers: Record<string, unknown>): void {
	writeFileSync(path, `${JSON.stringify({ providers }, null, 2)}\n`);
}

test("createIoModelRuntime passes persisted paths and restores the catalog offline", async () => {
	const root = tempRoot();
	try {
		const paths = resolvePaths({ IO_CONFIG_DIR: join(root, "config"), IO_DATA_DIR: join(root, "data") });
		const calls: Array<Record<string, unknown>> = [];
		const refreshCalls: Array<Record<string, unknown>> = [];
		const stub = { refresh: async (options: Record<string, unknown>) => {
			refreshCalls.push(options);
			return { aborted: false, errors: new Map() };
		} };
		const runtime = await createIoModelRuntime(paths, async (options) => {
			const opts = options as Record<string, unknown>;
			calls.push(opts);
			return stub as never;
		});
		assert.equal(runtime as never, stub as never);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.["modelsPath"], paths.modelsPath);
		assert.equal(calls[0]?.["authPath"], paths.authPath);
		assert.equal(calls[0]?.["refreshOnCreate"], false);
		// Create replays the persisted overlay without touching the network.
		assert.equal(refreshCalls.length, 1);
		assert.equal(refreshCalls[0]?.["allowNetwork"], false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("restoreCatalogs never requests network access", async () => {
	const seen: Array<Record<string, unknown>> = [];
	const stub = { refresh: async (options: Record<string, unknown>) => {
		seen.push(options);
		return { aborted: false, errors: new Map() };
	} };
	await restoreCatalogs(stub as never);
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.["allowNetwork"], false);
	assert.equal(seen[0]?.["force"], undefined);
});

test("refreshCatalogs defaults to forced network refresh with a 15s timeout", async () => {
	const seen: Array<Record<string, unknown>> = [];
	const stub = { refresh: async (options: Record<string, unknown>) => {
		seen.push(options);
		return { aborted: false, errors: new Map() };
	} };
	const result = await refreshCatalogs(stub as never, "opencode-go");
	assert.equal(result.aborted, false);
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.["allowNetwork"], true);
	assert.equal(seen[0]?.["force"], true);
	assert.deepEqual(seen[0]?.["providers"], ["opencode-go"]);
	assert.equal(typeof (seen[0]?.["signal"] as AbortSignal), "object");
});

test("refreshCatalogs honors force:false for background refreshes", async () => {
	const seen: Array<Record<string, unknown>> = [];
	const stub = { refresh: async (options: Record<string, unknown>) => {
		seen.push(options);
		return { aborted: false, errors: new Map() };
	} };
	await refreshCatalogs(stub as never, undefined, { force: false });
	assert.equal(seen[0]?.["force"], false);
});

test("readConfiguredProviderIds lists providers and tolerates malformed files", () => {
	const root = tempRoot();
	try {
		const path = join(root, "models.json");
		assert.deepEqual(readConfiguredProviderIds(path), []);

		writeFileSync(path, "{not json");
		assert.deepEqual(readConfiguredProviderIds(path), []);

		writeModelsFile(path, { "50x": { name: "50x" }, local: { name: "Local" } });
		assert.deepEqual(readConfiguredProviderIds(path), ["50x", "local"]);

		writeFileSync(path, JSON.stringify({ providers: [] }));
		assert.deepEqual(readConfiguredProviderIds(path), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("models.json providers join the catalog after the io built-ins", async () => {
	const root = tempRoot();
	try {
		const paths = resolvePaths({ IO_CONFIG_DIR: join(root, "config"), IO_DATA_DIR: join(root, "data") });
		mkdirSync(paths.dataDir, { recursive: true });
		writeModelsFile(paths.modelsPath, { "50x": { name: "50x" } });
		const stub = {
			refresh: async () => ({ aborted: false, errors: new Map() }),
			getProvider: (id: string) => ({ id, name: id === "50x" ? "50x" : id }),
			getAvailable: async (id: string) =>
				id === "50x"
					? [model("50x", "deepseek-ai/DeepSeek-V4.1-Flash-1017")]
					: id === "opencode-go"
						? [model("opencode-go", "beam-free")]
						: [],
			checkAuth: async () => undefined,
		};
		const runtime = await createIoModelRuntime(paths, async () => stub as never);
		assert.deepEqual(knownProviderIds(runtime), [
			"opencode-go",
			"openai-codex",
			"amazon-bedrock",
			"50x",
		]);

		const available = await loadAvailableModels(runtime);
		assert.deepEqual(
			available.models.map((entry) => `${entry.provider}/${entry.id}`),
			["opencode-go/beam-free", "50x/deepseek-ai/DeepSeek-V4.1-Flash-1017"],
		);
		assert.equal(available.providerNames.get("50x"), "50x");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("refreshCatalogs skips providers defined only in models.json", async () => {
	let calls = 0;
	const stub = {
		refresh: async () => {
			calls++;
			return { aborted: false, errors: new Map() };
		},
	};
	const result = await refreshCatalogs(stub as never, "50x");
	assert.equal(result.aborted, false);
	assert.equal(result.errors.size, 0);
	assert.equal(calls, 0);
});

test("readProviderEnvNames finds credential and header environment references", () => {
	const root = tempRoot();
	try {
		const path = join(root, "models.json");
		writeModelsFile(path, {
			"50x": {
				apiKey: "$FIFTYX_API_KEY",
				headers: {
					"X-Api-Key": "${EXTRA_API_KEY}",
					"X-Literal": "plain-value",
					"X-Escaped": "$$NOT_AN_ENV",
				},
			},
			local: { apiKey: "!echo command-output" },
		});
		assert.deepEqual(readProviderEnvNames(path).sort(), ["EXTRA_API_KEY", "FIFTYX_API_KEY"]);
		assert.deepEqual(readProviderEnvNames(join(root, "missing.json")), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reloadModelsJson picks up newly added custom providers without network", async () => {
	const root = tempRoot();
	try {
		const paths = resolvePaths({ IO_CONFIG_DIR: join(root, "config"), IO_DATA_DIR: join(root, "data") });
		mkdirSync(paths.dataDir, { recursive: true });
		writeModelsFile(paths.modelsPath, { "50x": { name: "50x" } });
		const refreshCalls: Array<Record<string, unknown>> = [];
		const stub = {
			refresh: async (options: Record<string, unknown>) => {
				refreshCalls.push(options);
				return { aborted: false, errors: new Map() };
			},
			getProvider: (id: string) => ({ id, name: id }),
			getAvailable: async () => [],
			checkAuth: async () => undefined,
		};
		const runtime = await createIoModelRuntime(paths, async () => stub as never);

		writeModelsFile(paths.modelsPath, { local: { name: "Local" } });
		await reloadModelsJson(runtime, paths.modelsPath);

		assert.equal(refreshCalls.at(-1)?.["allowNetwork"], false);
		assert.deepEqual(knownProviderIds(runtime), [
			"opencode-go",
			"openai-codex",
			"amazon-bedrock",
			"local",
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
