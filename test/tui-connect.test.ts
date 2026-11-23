import assert from "node:assert/strict";
import test from "node:test";
import type { AuthCredential, AuthHost } from "../src/commands/next-auth.js";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

function fakeHost(): AuthHost & { removed: string[]; closed: boolean } {
	const credentials: AuthCredential[] = [
		{ id: "cred-50x", integrationID: "50x", label: "API key", active: true, value: { type: "key" } },
	];
	const host = {
		removed: [] as string[],
		closed: false,
		integration: {
			list: async () => ({
				data: [
					{
						id: "openai",
						name: "OpenAI",
						methods: [{ id: "oauth", type: "oauth", label: "ChatGPT" }],
						connections: [],
					},
					{ id: "50x", name: "50x", methods: [{ type: "key" }], connections: [] },
				],
			}),
			oauth: {
				connect: async () => ({
					data: {
						attemptID: "attempt-1",
						url: "https://example.com/authorize",
						instructions: "Sign in to continue",
						mode: "poll",
					},
				}),
				status: async () => ({ data: { status: "pending" } }),
				complete: async () => undefined,
			},
		},
		provider: {
			list: async () => ({
				data: [
					{ id: "openai", name: "OpenAI", integrationID: "openai" },
					{ id: "50x", name: "50x", integrationID: "50x" },
				],
			}),
		},
		credential: {
			list: async () => credentials,
			create: async (input: { integrationID: string; label?: string; value: { type: "key"; key: string }; activate?: boolean }) => {
				const credential: AuthCredential = {
					id: `cred-${input.integrationID}`,
					integrationID: input.integrationID,
					label: input.label ?? "API key",
					active: input.activate === true,
					value: { type: input.value.type },
				};
				credentials.push(credential);
				return credential;
			},
			remove: async ({ credentialID }: { credentialID: string }) => {
				host.removed.push(credentialID);
				const index = credentials.findIndex((credential) => credential.id === credentialID);
				if (index >= 0) credentials.splice(index, 1);
			},
			activate: async () => undefined,
		},
		close: async () => {
			host.closed = true;
		},
	};
	return host as unknown as AuthHost & { removed: string[]; closed: boolean };
}

test("io connect dialog lists providers, starts OAuth and disconnects credentials", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoConnectDialog } = await import("../src/tui/next/connect-dialog.js");

	const setup = await createTestRenderer({ width: 110, height: 30 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	const host = fakeHost();
	let closed = 0;
	const dialog = new IoConnectDialog({
		renderer: setup.renderer,
		shell,
		cwd: "/home/oscar/project",
		createHost: async () => host,
		onClose: () => {
			closed += 1;
		},
	});

	try {
		await dialog.open();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Connect/);
		assert.match(frame, /OpenAI/);
		assert.match(frame, /50x/);
		assert.match(frame, /active/);
		assert.match(frame, /oauth/);

		assert.equal(dialog.selectedEntry?.key, "openai");
		await dialog.connectSelected();
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /https:\/\/example\.com\/authorize/);

		dialog.close();
		assert.equal(closed, 1);
		assert.equal(host.closed, true);
	} finally {
		dialog.dispose();
		shell.dispose();
		await setup.dispose();
	}
});

test("io connect dialog removes stored credentials", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoConnectDialog } = await import("../src/tui/next/connect-dialog.js");

	const setup = await createTestRenderer({ width: 110, height: 30 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	const host = fakeHost();
	const dialog = new IoConnectDialog({
		renderer: setup.renderer,
		shell,
		cwd: "/home/oscar/project",
		createHost: async () => host,
	});

	try {
		await dialog.open();
		dialog.move(1);
		assert.equal(dialog.selectedEntry?.key, "50x");
		await dialog.disconnectSelected();
		await setup.renderOnce();
		assert.deepEqual(host.removed, ["cred-50x"]);
		assert.match(setup.captureCharFrame(), /Removed 1 credential/);
	} finally {
		dialog.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
