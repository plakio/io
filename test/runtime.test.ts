import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolvePaths } from "../src/config.js";
import { createIoModelRuntime, restoreCatalogs, refreshCatalogs } from "../src/runtime.js";

function tempRoot(): string {
	const root = join(tmpdir(), `io-runtime-${process.pid}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return root;
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
