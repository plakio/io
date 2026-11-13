import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ensureIoDirectories,
	loadConfig,
	parseConfig,
	resolveContextSettings,
	resolvePermissionMode,
	resolvePaths,
	saveConfig,
	THINKING_LEVELS,
	VERBOSITY_LEVELS,
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
	assert.equal(paths.modelsPath, "/x/data/io/models.json");
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

test("verbosity parses and rejects unknown levels", () => {
	for (const level of VERBOSITY_LEVELS) {
		assert.equal(parseConfig({ verbosity: level }).config.verbosity, level);
	}
	assert.deepEqual(parseConfig({ verbosity: "loud" }), {
		config: {},
		warnings: ["ignoring invalid config value: verbosity"],
	});
});

test("saveConfig and loadConfig round-trip with owner-only permissions", () => {
	const root = tempRoot();
	try {
		const paths = resolvePaths({ IO_CONFIG_DIR: join(root, "config"), IO_DATA_DIR: join(root, "data") });
		saveConfig(paths, { provider: "openai-codex", model: "gpt-6-sol", thinkingLevel: "low", verbosity: "low" });
		const loaded = loadConfig(paths);
		assert.deepEqual(loaded.config, {
			provider: "openai-codex",
			model: "gpt-6-sol",
			thinkingLevel: "low",
			verbosity: "low",
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
		assert.match(loaded.error ?? "", /could not parse/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("saveConfig preserves unknown keys written by a newer version", () => {
	const root = tempRoot();
	try {
		const paths = resolvePaths({ IO_CONFIG_DIR: join(root, "config"), IO_DATA_DIR: join(root, "data") });
		ensureIoDirectories(paths);
		writeFileSync(
			paths.configPath,
			`${JSON.stringify({ futureKey: { nested: true }, verbosity: "high" }, null, 2)}\n`,
		);
		const current = loadConfig(paths).config;
		saveConfig(paths, { ...current, verbosity: "low" });
		const raw = JSON.parse(readFileSync(paths.configPath, "utf8")) as Record<string, unknown>;
		assert.deepEqual(raw.futureKey, { nested: true });
		assert.equal(raw.verbosity, "low");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("context settings default to enabled and can be disabled", () => {
	assert.deepEqual(resolveContextSettings({}), { skills: true, contextFiles: true });
	assert.deepEqual(resolveContextSettings({ skills: false }), { skills: false, contextFiles: true });
	assert.deepEqual(resolveContextSettings({ contextFiles: false }), { skills: true, contextFiles: false });
	assert.deepEqual(parseConfig({ skills: false, contextFiles: true }).config, { skills: false, contextFiles: true });
	assert.deepEqual(parseConfig({ skills: "yes" }).warnings, ["ignoring invalid config value: skills"]);
});

test("permission rules parse and invalid entries warn", () => {
	const parsed = parseConfig({
		permissions: [
			{ resource: "git push *", effect: "ask" },
			{ resource: "npm install", effect: "allow" },
			{ resource: "rm -rf build", effect: "deny" },
		],
	});
	assert.deepEqual(parsed.config.permissions, [
		{ resource: "git push *", effect: "ask" },
		{ resource: "npm install", effect: "allow" },
		{ resource: "rm -rf build", effect: "deny" },
	]);
	assert.deepEqual(parsed.warnings, []);

	const invalid = parseConfig({
		permissions: [{ resource: "ok", effect: "maybe" }, { resource: 3, effect: "allow" }, "nope"],
	});
	assert.deepEqual(invalid.config.permissions, undefined);
	assert.match(invalid.warnings[0] ?? "", /invalid entries in permissions/);
});


test("permissionMode and bell parse, and invalid values warn", () => {
	assert.equal(parseConfig({ permissionMode: "auto" }).config.permissionMode, "auto");
	assert.equal(parseConfig({ permissionMode: "ask" }).config.permissionMode, "ask");
	assert.deepEqual(parseConfig({ permissionMode: "yolo" }), {
		config: {},
		warnings: ["ignoring invalid config value: permissionMode"],
	});
	assert.equal(parseConfig({ bell: false }).config.bell, false);
	assert.deepEqual(parseConfig({ bell: "loud" }), {
		config: {},
		warnings: ["ignoring invalid config value: bell"],
	});
	assert.equal(resolvePermissionMode({}), "ask");
	assert.equal(resolvePermissionMode({ permissionMode: "auto" }), "auto");
});
