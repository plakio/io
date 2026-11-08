import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/args.js";

test("no arguments starts an interactive session", () => {
	const parsed = parseArgs([]);
	assert.equal(parsed.error, undefined);
	assert.deepEqual(parsed.command, { kind: "interactive", continueSession: false });
});

test("help and version are recognized", () => {
	assert.deepEqual(parseArgs(["--help"]).command, { kind: "help" });
	assert.deepEqual(parseArgs(["-h"]).command, { kind: "help" });
	assert.deepEqual(parseArgs(["help"]).command, { kind: "help" });
	assert.deepEqual(parseArgs(["--version"]).command, { kind: "version" });
	assert.deepEqual(parseArgs(["version"]).command, { kind: "version" });
});

test("auth commands parse optional providers", () => {
	assert.deepEqual(parseArgs(["auth"]).command, { kind: "auth-status" });
	assert.deepEqual(parseArgs(["auth", "status"]).command, { kind: "auth-status" });
	assert.deepEqual(parseArgs(["auth", "login"]).command, { kind: "auth-login", provider: undefined });
	assert.deepEqual(parseArgs(["auth", "login", "opencode-go"]).command, {
		kind: "auth-login",
		provider: "opencode-go",
	});
	assert.deepEqual(parseArgs(["auth", "logout", "openai-codex"]).command, {
		kind: "auth-logout",
		provider: "openai-codex",
	});
});

test("models, sessions, and config parse", () => {
	assert.deepEqual(parseArgs(["models"]).command, { kind: "models", provider: undefined, refresh: false });
	assert.deepEqual(parseArgs(["models", "opencode-go", "--refresh"]).command, {
		kind: "models",
		provider: "opencode-go",
		refresh: true,
	});
	assert.deepEqual(parseArgs(["sessions"]).command, { kind: "sessions" });
	assert.deepEqual(parseArgs(["config"]).command, { kind: "config-interactive" });
	assert.deepEqual(parseArgs(["config", "show"]).command, { kind: "config-show" });
	assert.deepEqual(parseArgs(["config", "edit"]).command, { kind: "config-interactive" });
	assert.deepEqual(parseArgs(["config", "set", "provider", "opencode-go"]).command, {
		kind: "config-set",
		key: "provider",
		value: "opencode-go",
	});
});

test("interactive options parse", () => {
	assert.deepEqual(parseArgs(["--continue"]).command, {
		kind: "interactive",
		continueSession: true,
	});
	assert.deepEqual(parseArgs(["--session", "01ABC"]).command, {
		kind: "interactive",
		continueSession: false,
		sessionId: "01ABC",
	});
	assert.deepEqual(parseArgs(["-m", "opencode-go/glm-5.3", "--provider", "opencode-go"]).command, {
		kind: "interactive",
		continueSession: false,
		modelRef: "opencode-go/glm-5.3",
		provider: "opencode-go",
	});
});

test("invalid arguments report errors", () => {
	assert.match(parseArgs(["--wat"]).error ?? "", /unknown option/);
	assert.match(parseArgs(["--session"]).error ?? "", /requires a value/);
	assert.match(parseArgs(["--continue", "--session", "x"]).error ?? "", /cannot be used together/);
	assert.match(parseArgs(["auth", "wat"]).error ?? "", /unknown auth command/);
	assert.match(parseArgs(["config", "set", "provider"]).error ?? "", /usage: io config set/);
	assert.match(parseArgs(["models", "a", "b"]).error ?? "", /unexpected argument/);
});
