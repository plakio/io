import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	loadConfig,
	parseConfig,
	resolvePaths,
	saveConfig,
	THINKING_LEVELS,
} from "../src/config.js";

function tempRoot(): string {
	const root = join(tmpdir(), `io-config-${process.pid}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return root;
}

test("resolvePaths honors XDG directories", () => {
	const paths = resolvePaths(
		{ XDG_CONFIG_HOME: "/x/config", XDG_DATA_HOME: "/x/data" },
		"/home/example",
	);
	assert.equal(paths.configDir, "/x/config/io");
	assert.equal(paths.dataDir, "/x/data/io");
	assert.equal(paths.authPath, "/x/data/io/auth.json");
	assert.equal(paths.sessionsDir, "/x/data/io/sessions");
});

test("resolvePaths honors IO overrides", () => {
	const paths = resolvePaths({ IO_CONFIG_DIR: "~/io-config", IO_DATA_DIR: "/tmp/io-data" }, "/home/example");
	assert.equal(paths.configDir, "/home/example/io-config");
	assert.equal(paths.dataDir, "/tmp/io-data");
});

test("parseConfig keeps valid values and warns on invalid ones", () => {
	const parsed = parseConfig({ provider: "opencode-go", model: "glm-5.3", thinkingLevel: "high", extra: true });
	assert.deepEqual(parsed.config, { provider: "opencode-go", model: "glm-5.3", thinkingLevel: "high" });
	assert.deepEqual(parsed.warnings, []);

	const invalid = parseConfig({ provider: 3, model: "", thinkingLevel: "turbo" });
	assert.deepEqual(invalid.config, {});
	assert.equal(invalid.warnings.length, 3);
});

test("all supported thinking levels parse", () => {
	for (const level of THINKING_LEVELS) {
		assert.equal(parseConfig({ thinkingLevel: level }).config.thinkingLevel, level);
	}
});

test("saveConfig and loadConfig round-trip with owner-only permissions", () => {
	const root = tempRoot();
	try {
		const paths = resolvePaths({ IO_CONFIG_DIR: join(root, "config"), IO_DATA_DIR: join(root, "data") });
		saveConfig(paths, { provider: "openai-codex", model: "gpt-6-sol", thinkingLevel: "low" });
		const loaded = loadConfig(paths);
		assert.deepEqual(loaded.config, {
			provider: "openai-codex",
			model: "gpt-6-sol",
			thinkingLevel: "low",
		});
		assert.deepEqual(loaded.warnings, []);
		assert.equal(statSync(paths.configPath).mode & 0o777, 0o600);
		assert.match(readFileSync(paths.configPath, "utf8"), /openai-codex/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("malformed config does not crash and produces a warning", () => {
	const root = tempRoot();
	try {
		const paths = resolvePaths({ IO_CONFIG_DIR: join(root, "config"), IO_DATA_DIR: join(root, "data") });
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(paths.configPath, "{not json");
		const loaded = loadConfig(paths);
		assert.deepEqual(loaded.config, {});
		assert.match(loaded.warnings[0] ?? "", /could not parse/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
