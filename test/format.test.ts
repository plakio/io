import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatContext,
	formatCwdForFooter,
	formatDuration,
	formatSpeed,
	formatTokens,
	oneLine,
	shortSessionId,
} from "../src/format.js";

test("token counts format compactly", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1234), "1.2k");
	assert.equal(formatTokens(12345), "12.3k");
	assert.equal(formatTokens(123456), "123k");
	assert.equal(formatTokens(1_234_567), "1.2M");
});

test("durations format by magnitude", () => {
	assert.equal(formatDuration(250), "250ms");
	assert.equal(formatDuration(1250), "1.3s");
	assert.equal(formatDuration(65_000), "1m 5s");
});

test("generation speed requires real token and duration data", () => {
	assert.equal(formatSpeed(0, 1000), undefined);
	assert.equal(formatSpeed(100, undefined), undefined);
	assert.equal(formatSpeed(100, 2000), "50 tok/s");
	assert.equal(formatSpeed(5, 2000), "2.5 tok/s");
});

test("context formatting degrades gracefully", () => {
	assert.equal(formatContext(undefined), undefined);
	assert.equal(formatContext({ tokens: null, contextWindow: 1000, percent: null }), undefined);
	assert.equal(formatContext({ tokens: 100, contextWindow: 1000, percent: 10 }), "ctx 10%");
	assert.equal(formatContext({ tokens: 100, contextWindow: 1000, percent: 2.5 }), "ctx 2.5%");
});

test("oneLine trims and truncates", () => {
	assert.equal(oneLine("  hello\n world  ", 30), "hello world");
	assert.equal(oneLine("abcdefghij", 6), "abcde…");
	assert.equal(shortSessionId("0123456789abcdef"), "01234567");
});

test("formatCwdForFooter shortens home-relative paths like Pi", () => {
	assert.equal(formatCwdForFooter("/home/oscar/io", "/home/oscar"), "~/io");
	assert.equal(formatCwdForFooter("/home/oscar/io/sub", "/home/oscar"), "~/io/sub");
	assert.equal(formatCwdForFooter("/home/oscar", "/home/oscar"), "~");
	assert.equal(formatCwdForFooter("/tmp/x", "/home/oscar"), "/tmp/x");
	assert.equal(formatCwdForFooter("/home/oscar/io", undefined), "/home/oscar/io");
	assert.equal(formatCwdForFooter("/home/oscar-other/io", "/home/oscar"), "/home/oscar-other/io");
});
