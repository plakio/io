import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, fetchLatestRelease, isHomebrewManaged, parseReleaseVersion } from "../src/update.js";

test("parseReleaseVersion normalizes tags", () => {
	assert.equal(parseReleaseVersion("v0.1.12"), "0.1.12");
	assert.equal(parseReleaseVersion("0.1.12"), "0.1.12");
	assert.equal(parseReleaseVersion(" v1.2.3 "), "1.2.3");
	assert.equal(parseReleaseVersion("v1.2"), undefined);
	assert.equal(parseReleaseVersion("nightly"), undefined);
	assert.equal(parseReleaseVersion(""), undefined);
});

test("compareVersions orders numeric triples", () => {
	assert.equal(compareVersions("0.1.12", "0.1.11"), 1);
	assert.equal(compareVersions("0.1.0", "0.1.12"), -1);
	assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
	assert.equal(compareVersions("0.1.12", "0.1.12"), 0);
	assert.equal(compareVersions("v0.1.12", "0.1.12"), 0);
	assert.equal(compareVersions("0.1.12", "0.1.9"), 1);
});

test("fetchLatestRelease parses a GitHub release response", async () => {
	const seen: Array<[string, Record<string, string> | undefined]> = [];
	const fetcher = async (input: string, init?: { headers?: Record<string, string> }) => {
		seen.push([input, init?.headers]);
		return {
			ok: true,
			status: 200,
			json: async () => ({
				tag_name: "v0.1.13",
				published_at: "2026-11-10T00:00:00Z",
				html_url: "https://github.com/plakio/io/releases/tag/v0.1.13",
			}),
		};
	};
	const result = await fetchLatestRelease(fetcher as never);
	assert.equal(result?.version, "0.1.13");
	assert.equal(result?.tag, "v0.1.13");
	assert.equal(result?.publishedAt, "2026-11-10T00:00:00Z");
	assert.match(seen[0]?.[0] ?? "", /api\.github\.com\/repos\/plakio\/io\/releases\/latest/);
});

test("fetchLatestRelease returns undefined on HTTP errors and bad payloads", async () => {
	const notFound = async () => ({ ok: false, status: 403, json: async () => ({}) });
	assert.equal(await fetchLatestRelease(notFound as never), undefined);
	const bad = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "nightly" }) });
	assert.equal(await fetchLatestRelease(bad as never), undefined);
	const missing = async () => ({ ok: true, status: 200, json: async () => ({ name: "io" }) });
	assert.equal(await fetchLatestRelease(missing as never), undefined);
});

test("fetchLatestRelease sends a User-Agent", async () => {
	let userAgent: string | undefined;
	const fetcher = async (_input: string, init?: { headers?: Record<string, string> }) => {
		userAgent = init?.headers?.["User-Agent"];
		return { ok: true, status: 200, json: async () => ({ tag_name: "v0.1.13" }) };
	};
	await fetchLatestRelease(fetcher as never, { userAgent: "io/0.1.12" });
	assert.equal(userAgent, "io/0.1.12");
});

test("isHomebrewManaged detects Cellar entry points", () => {
	const previous = process.env.IO_BREW_MANAGED;
	delete process.env.IO_BREW_MANAGED;
	try {
		assert.equal(isHomebrewManaged("/home/linuxbrew/.linuxbrew/Cellar/io/0.1.15/libexec/dist/cli.js"), true);
		assert.equal(isHomebrewManaged("/opt/homebrew/Cellar/io/1.2.3/libexec/dist/cli.js"), true);
		assert.equal(isHomebrewManaged("/home/oscar/io/dist/cli.js"), false);
		assert.equal(isHomebrewManaged(undefined), false);
		process.env.IO_BREW_MANAGED = "1";
		assert.equal(isHomebrewManaged("/home/oscar/io/dist/cli.js"), true);
	} finally {
		if (previous === undefined) delete process.env.IO_BREW_MANAGED;
		else process.env.IO_BREW_MANAGED = previous;
	}
});
