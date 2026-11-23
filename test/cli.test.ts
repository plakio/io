import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

function run(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
	const dir = mkdtempSync(join(tmpdir(), "io-cli-"));
	try {
		const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
			cwd: root,
			encoding: "utf8",
			timeout: 30_000,
			env: {
				...process.env,
				IO_CONFIG_DIR: join(dir, "config"),
				IO_DATA_DIR: join(dir, "data"),
				...env,
			},
		});
		return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("new CLI exposes version and help", () => {
	const versionResult = run(["--version"]);
	assert.equal(versionResult.status, 0);
	assert.equal(versionResult.stdout.trim(), `io ${version}`);

	const help = run(["--help"]);
	assert.equal(help.status, 0);
	assert.match(help.stdout, /io run/);
	assert.match(help.stdout, /io models/);
	assert.match(help.stdout, /io auth status/);
});

test("new CLI config show reads io config without Pi", () => {
	const result = run(["config", "show"]);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /theme\s+io/);
	assert.match(result.stdout, /verbosity\s+normal/);
});

test("new CLI auth help does not require a provider", () => {
	const result = run(["auth", "--help"]);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /io auth status/);
});
