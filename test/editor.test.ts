import assert from "node:assert/strict";
import { test } from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { cleanPastedText, IoEditor } from "../src/tui/editor.js";
import { editorTheme } from "../src/tui/theme.js";

function fakeTui(): TUI {
	return {
		terminal: { rows: 24, columns: 80, isTTY: true },
		requestRender() {},
	} as unknown as TUI;
}

function editor(): IoEditor {
	return new IoEditor(fakeTui(), editorTheme);
}

function paste(target: IoEditor, text: string): void {
	(target as unknown as { handlePaste: (value: string) => void }).handlePaste(text);
}

test("cleanPastedText normalizes line endings and removes control bytes", () => {
	assert.equal(cleanPastedText("a\r\nb\rc"), "a\nb\nc");
	assert.equal(cleanPastedText("a\u0000b\u0007c"), "abc");
	assert.equal(cleanPastedText("\x1b[200~hello\x1b[201~"), "hello");
	assert.equal(cleanPastedText("line 1\nline 2\n"), "line 1\nline 2\n");
});

test("large multiline pastes stay visible instead of becoming a marker", () => {
	const target = editor();
	const content = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
	paste(target, content);
	assert.equal(target.getText(), content);
	assert.equal(target.getExpandedText(), content);
	assert.doesNotMatch(target.getText(), /\[paste #/);
	assert.doesNotMatch(target.getText(), /pasted text/i);
});

test("large single-line pastes stay complete and editable", () => {
	const target = editor();
	const content = "x".repeat(5000);
	paste(target, content);
	assert.equal(target.getText().length, 5000);
	assert.equal(target.getText(), content);
	assert.doesNotMatch(target.getText(), /\[paste #/);
});

test("pastes can be edited after insertion", () => {
	const target = editor();
	paste(target, "first\nsecond");
	target.handleInput("!");
	assert.equal(target.getText(), "first\nsecond!");
	target.handleInput("\u007f");
	assert.equal(target.getText(), "first\nsecond");
});
