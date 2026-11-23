#!/usr/bin/env node

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "dist-next");
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const args = process.argv.slice(2);
const targetArg = args.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
	?? (args.includes("--target") ? args[args.indexOf("--target") + 1] : undefined);

const hostTarget = `${process.platform}-${process.arch}`;
const targets = {
	"linux-arm64": { bun: "bun-linux-arm64", pty: "@opencode/pty-linux-arm64-gnu", libc: "glibc", core: "@opentui/core-linux-arm64" },
	"linux-x64": { bun: "bun-linux-x64", pty: "@opencode/pty-linux-x64-gnu", libc: "glibc", core: "@opentui/core-linux-x64" },
	"darwin-arm64": { bun: "bun-darwin-arm64", pty: "@opencode/pty-darwin-arm64", core: "@opentui/core-darwin-arm64" },
	"darwin-x64": { bun: "bun-darwin-x64", pty: "@opencode/pty-darwin-x64", core: "@opentui/core-darwin-x64" },
};
const requestedTarget = (targetArg ?? hostTarget).replace(/^bun-/, "");
const target = targets[requestedTarget];
const crossBuild = requestedTarget !== hostTarget;
if (!target) {
	console.error(`build-next: unsupported target ${targetArg ?? hostTarget}`);
	process.exit(1);
}

function run(command, commandArgs, options = {}) {
	const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function hasBun() {
	return spawnSync("bun", ["--version"], { cwd: root, stdio: "ignore" }).status === 0;
}
const bunPrefix = hasBun() ? ["bun"] : ["npx", "-y", "bun@1.4.5"];

function ensureClaudeStub() {
	const directory = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
	if (existsSync(join(directory, "package.json"))) return;
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0-io-stub", type: "module", license: "MIT", exports: { ".": "./index.js" } }, null, 2) + "\n",
	);
	writeFileSync(join(directory, "index.js"), "// io build stub: the Claude Agent provider is not part of io.\nexport {};\n");
	console.log("build-next: installed @anthropic-ai/claude-agent-sdk build stub");
}

function ensureTargetPackages() {
	if (!existsSync(join(root, "node_modules", target.core, "package.json"))) {
		console.error(`build-next: missing ${target.core}. Install the matching @opentui/core optional package for ${targetArg ?? hostTarget}.`);
		process.exit(1);
	}
	if (!existsSync(join(root, "node_modules", target.pty, "package.json"))) {
		console.error(`build-next: missing ${target.pty}. Install it with: npm install --no-save ${target.pty}`);
		process.exit(1);
	}
}

ensureClaudeStub();
ensureTargetPackages();
run("node", ["scripts/patch-opencode-ws.mjs"]);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const output = join(outDir, "io.bin");
const wrapper = join(outDir, "io");
const define = [["--define", `process.env.IO_VERSION="${packageVersion}"`]];
if (target.libc) define.push(["--define", `process.env.OPENTUI_LIBC="${target.libc}"`]);
run(bunPrefix[0], [...bunPrefix.slice(1), "build", "--compile", "src/cli.ts", "--outfile", output, `--target=${target.bun}`, ...define.flat()]);
chmodSync(output, 0o755);
writeFileSync(
	wrapper,
	`#!/bin/sh
SELF=$0
while [ -L "$SELF" ]; do
  TARGET=$(readlink "$SELF")
  case $TARGET in
    /*) SELF=$TARGET ;;
    *) SELF=$(dirname "$SELF")/$TARGET ;;
  esac
done
DIR=$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)
NODE_PATH="$DIR/node_modules\${NODE_PATH:+:$NODE_PATH}" exec "$DIR/io.bin" "$@"
`,
);
chmodSync(wrapper, 0o755);

const ptyTarget = join(outDir, "node_modules", "@opencode", target.pty.split("/")[1]);
mkdirSync(dirname(ptyTarget), { recursive: true });
cpSync(join(root, "node_modules", target.pty), ptyTarget, { recursive: true, dereference: true });

cpSync(join(root, "LICENSE"), join(outDir, "LICENSE"));
cpSync(join(root, "README.md"), join(outDir, "README.next.md"));
run("node", ["scripts/collect-licenses.mjs", join(outDir, "THIRD_PARTY_NOTICES.txt")], {
	env: { ...process.env, IO_INCLUDE_DEV: "1" },
});

let smoke = { status: 0, stdout: "(cross build; smoke skipped)" };
if (!crossBuild) {
	smoke = spawnSync(wrapper, ["--version"], { cwd: outDir, encoding: "utf8" });
	if (smoke.status !== 0) {
		console.error(`build-next: smoke test failed (${smoke.status})\n${smoke.stderr ?? ""}`);
		process.exit(1);
	}
}
const size = statSync(output).size;
const ptySize = statSync(ptyTarget).isDirectory()
	? readdirSize(ptyTarget)
	: statSync(ptyTarget).size;
console.log(`build-next: ${wrapper}`);
console.log(`build-next: binary ${(size / 1048576).toFixed(1)} MB + pty sidecar ${(ptySize / 1048576).toFixed(1)} MB`);
console.log(`build-next: ${String(smoke.stdout).trim()}`);

function readdirSize(directory) {
	let total = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		total += entry.isDirectory() ? readdirSize(path) : statSync(path).size;
	}
	return total;
}
