import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AuthCredential, AuthHost, AuthPrompt } from "../src/commands/next-auth.js";
import { authImport, authLogin, authLogout, authStatus } from "../src/commands/next-auth.js";

class FakeAuthHost implements AuthHost {
	credentials: AuthCredential[] = [];
	created: Array<{ integrationID: string; value: { type: string; key: string } }> = [];
	removed: string[] = [];
	oauthUrl = "";
	integration = {
		list: async () => ({
			data: [
				{
					id: "oauth-provider",
					name: "OAuth Provider",
					methods: [{ id: "oauth", type: "oauth", label: "Sign in" }],
					connections: [],
				},
			],
		}),
		oauth: {
			connect: async () => ({
				data: { attemptID: "attempt", url: "https://example.test/auth", instructions: "Sign in", mode: "code" },
			}),
			status: async () => ({ data: { status: "complete" } }),
			complete: async () => {},
		},
	};
	provider = {
		list: async () => ({
			data: [
				{ id: "opencode-go", name: "OpenCode Go", integrationID: "opencode-go" },
				{ id: "openai", name: "OpenAI", integrationID: "openai" },
				{ id: "oauth-provider", name: "OAuth Provider", integrationID: "oauth-provider" },
			],
		}),
	};
	credential = {
		list: async () => this.credentials,
		create: async (input: { integrationID: string; value: { type: "key"; key: string } }) => {
			this.created.push({ integrationID: input.integrationID, value: input.value });
			const credential: AuthCredential = {
				id: `cred_${this.credentials.length + 1}`,
				integrationID: input.integrationID,
				label: "API key",
				active: true,
				value: { type: "key" },
			};
			this.credentials.push(credential);
			return credential;
		},
		remove: async ({ credentialID }: { credentialID: string }) => {
			this.removed.push(credentialID);
			this.credentials = this.credentials.filter((credential) => credential.id !== credentialID);
		},
		activate: async () => {},
	};
	async close(): Promise<void> {}
}

const prompt: AuthPrompt = {
	readLine: async () => "secret-key",
	select: async () => "opencode-go",
};

test("auth status prints providers and credentials", async () => {
	const host = new FakeAuthHost();
	host.credentials = [
		{ id: "cred_1", integrationID: "opencode-go", label: "API key", active: true, value: { type: "key" } },
	];
	let output = "";
	const code = await authStatus(host, "/tmp", { stdout: (text) => { output += text; }, stderr: () => {} });
	assert.equal(code, 0);
	assert.match(output, /OpenCode Go/);
	assert.match(output, /opencode-go/);
	assert.match(output, /active/);
});

test("auth login stores an API key", async () => {
	const host = new FakeAuthHost();
	let output = "";
	const code = await authLogin(
		host,
		"/tmp",
		{ provider: "opencode-go" },
		prompt,
		{ stdout: (text) => { output += text; }, stderr: () => {} },
	);
	assert.equal(code, 0);
	assert.deepEqual(host.created, [{ integrationID: "opencode-go", value: { type: "key", key: "secret-key" } }]);
	assert.match(output, /Stored API key/);
});

test("auth login runs the OAuth flow when the integration exposes it", async () => {
	const host = new FakeAuthHost();
	let output = "";
	const code = await authLogin(
		host,
		"/tmp",
		{ provider: "oauth-provider" },
		{ ...prompt, readLine: async () => "code-123" },
		{ stdout: (text) => { output += text; }, stderr: () => {} },
	);
	assert.equal(code, 0);
	assert.match(output, /https:\/\/example\.test\/auth/);
	assert.match(output, /Authenticated with oauth-provider/);
});

test("auth logout removes credentials by provider", async () => {
	const host = new FakeAuthHost();
	host.credentials = [
		{ id: "cred_1", integrationID: "opencode-go", label: "API key", active: true, value: { type: "key" } },
		{ id: "cred_2", integrationID: "other", label: "API key", active: true, value: { type: "key" } },
	];
	let output = "";
	const code = await authLogout(host, { provider: "opencode-go" }, {
		stdout: (text) => { output += text; },
		stderr: () => {},
	});
	assert.equal(code, 0);
	assert.deepEqual(host.removed, ["cred_1"]);
	assert.deepEqual(host.credentials.map((credential) => credential.id), ["cred_2"]);
	assert.match(output, /Removed 1 credential/);
});


test("auth import migrates Pi API keys and skips OAuth", async () => {
	const host = new FakeAuthHost();
	const root = mkdtempSync(join(tmpdir(), "io-auth-import-"));
	const authPath = join(root, "auth.json");
	writeFileSync(
		authPath,
		JSON.stringify({
			"opencode-go": { type: "api_key", key: "pi-key" },
			"openai-codex": { type: "oauth", access: "a", refresh: "r" },
			unknown: { type: "api_key", key: "other" },
		}),
	);
	let output = "";
	const code = await authImport(host, authPath, "/tmp", {
		stdout: (text) => { output += text; },
		stderr: (text) => { output += text; },
	});
	assert.equal(code, 0);
	assert.deepEqual(host.created, [{ integrationID: "opencode-go", value: { type: "key", key: "pi-key" } }]);
	assert.match(output, /OAuth credentials need an OpenCode login/);
	assert.match(output, /provider unknown is not configured/);
});
