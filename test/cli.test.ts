import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageVersion = (
	JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }
).version;

function run(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
	const cleanEnv = { ...process.env };
	delete cleanEnv.OPENCODE_API_KEY;
	const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
		cwd: root,
		encoding: "utf8",
		timeout: 20_000,
		input: "",
		env: { ...cleanEnv, ...env },
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function tempEnv(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "io-cli-"));
	return {
		env: {
			IO_CONFIG_DIR: join(dir, "config"),
			IO_DATA_DIR: join(dir, "data"),
			PI_OFFLINE: "1",
		},
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("--version reports the package version", () => {
	const result = run(["--version"]);
	assert.equal(result.status, 0);
	assert.equal(result.stdout.trim(), `io ${packageVersion}`);
});

test("--help documents the main commands", () => {
	const result = run(["--help"]);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /Usage:/);
	assert.match(result.stdout, /io auth login/);
	assert.match(result.stdout, /io models/);
	assert.match(result.stdout, /\/diff/);
});

test("unknown flags exit with a usage error", () => {
	const result = run(["--definitely-not-a-flag"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /unknown option/);
});

test("interactive mode explains that it needs a terminal", () => {
	const { env, cleanup } = tempEnv();
	try {
		const result = run([], env);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /requires a terminal/);
	} finally {
		cleanup();
	}
});

test("auth status works without credentials", () => {
	const { env, cleanup } = tempEnv();
	try {
		const result = run(["auth", "status"], env);
		assert.equal(result.status, 0);
		assert.match(result.stdout, /OpenCode Go/);
		assert.match(result.stdout, /not configured/);
		assert.match(result.stdout, /auth\.json/);
	} finally {
		cleanup();
	}
});

test("the bundled Codex OAuth flow is reachable", () => {
	const { env, cleanup } = tempEnv();
	try {
		const result = run(["auth", "login", "openai-codex"], env);
		assert.equal(result.status, 130);
		assert.match(result.stdout, /login method|Login cancelled/);
		assert.doesNotMatch(result.stderr, /Cannot find module/);
	} finally {
		cleanup();
	}
});

test("models explain how to authenticate when none are available", () => {
	const { env, cleanup } = tempEnv();
	try {
		const result = run(["models"], env);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /No authenticated models/);
		assert.match(result.stderr, /io auth login/);
	} finally {
		cleanup();
	}
});

test("config set persists a model preference", () => {
	const { env, cleanup } = tempEnv();
	try {
		const set = run(["config", "set", "model", "opencode-go/glm-5.3"], env);
		assert.equal(set.status, 0);
		const show = run(["config", "show"], env);
		assert.equal(show.status, 0);
		assert.match(show.stdout, /provider\s+opencode-go/);
		assert.match(show.stdout, /model\s+glm-5\.3/);
	} finally {
		cleanup();
	}
});

test("invalid config keys are rejected", () => {
	const { env, cleanup } = tempEnv();
	try {
		const result = run(["config", "set", "nonsense", "value"], env);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Unknown config key/);
	} finally {
		cleanup();
	}
});
