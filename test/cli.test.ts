import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function tempEnv(): { env: NodeJS.ProcessEnv; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "io-cli-"));
	return {
		env: {
			IO_CONFIG_DIR: join(dir, "config"),
			IO_DATA_DIR: join(dir, "data"),
			PI_OFFLINE: "1",
		},
		dir,
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

test("config set toggles skills and context files", () => {
	const { env, cleanup } = tempEnv();
	try {
		assert.equal(run(["config", "set", "skills", "off"], env).status, 0);
		assert.equal(run(["config", "set", "contextFiles", "off"], env).status, 0);
		const show = run(["config", "show"], env);
		assert.match(show.stdout, /skills\s+off/);
		assert.match(show.stdout, /context\s+off/);
		const invalid = run(["config", "set", "skills", "maybe"], env);
		assert.equal(invalid.status, 1);
		assert.match(invalid.stderr, /Use on or off/);
	} finally {
		cleanup();
	}
});

test("models.json OpenAI-compatible providers work with auth, models, and config", () => {
	const { env, dir, cleanup } = tempEnv();
	try {
		const dataDir = join(dir, "data");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(
			join(dataDir, "models.json"),
			`${JSON.stringify({
				providers: {
					"50x": {
						name: "50x",
						baseUrl: "https://api.ai.50x.energy/v1",
						api: "openai-completions",
						apiKey: "$FIFTYX_API_KEY",
						models: [
							{
								id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
								name: "DeepSeek V4.1 Flash 1017",
								reasoning: true,
							},
						],
					},
				},
			}, null, 2)}\n`,
		);

		const status = run(["auth", "status"], { ...env, FIFTYX_API_KEY: "test-key" });
		assert.equal(status.status, 0);
		assert.match(status.stdout, /50x\s+configured/);
		assert.match(status.stdout, /Providers:\s+.*50x/);

		const models = run(["models", "50x"], { ...env, FIFTYX_API_KEY: "test-key" });
		assert.equal(models.status, 0);
		assert.match(models.stdout, /50x \(50x\)/);
		assert.match(models.stdout, /DeepSeek-V4\.1-Flash-1017/);

		const set = run(
			["config", "set", "model", "50x/deepseek-ai/DeepSeek-V4.1-Flash-1017"],
			env,
		);
		assert.equal(set.status, 0);
		const show = run(["config", "show"], env);
		assert.match(show.stdout, /provider\s+50x/);
		assert.match(show.stdout, /model\s+deepseek-ai\/DeepSeek-V4\.1-Flash-1017/);

		const setProvider = run(["config", "set", "provider", "50x"], env);
		assert.equal(setProvider.status, 0);

		const unknown = run(["models", "nope"], env);
		assert.equal(unknown.status, 1);
		assert.match(unknown.stderr, /Configured providers: .*50x/);
	} finally {
		cleanup();
	}
});

test("models.json providers explain a missing api key", () => {
	const { env, dir, cleanup } = tempEnv();
	try {
		const dataDir = join(dir, "data");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(
			join(dataDir, "models.json"),
			`${JSON.stringify({
				providers: {
					"50x": {
						baseUrl: "https://api.ai.50x.energy/v1",
						api: "openai-completions",
						apiKey: "$FIFTYX_API_KEY",
						models: [{ id: "deepseek-ai/DeepSeek-V4.1-Flash-1017" }],
					},
				},
			})}\n`,
		);
		const cleanEnv = { ...env };
		delete cleanEnv.FIFTYX_API_KEY;
		const result = run(["models", "50x"], cleanEnv);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /No authenticated models/);
		assert.match(result.stderr, /models\.json/);
	} finally {
		cleanup();
	}
});
