import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	AssistantBlock,
	ConfirmOverlay,
	Footer,
	ToolBlock,
} from "../src/tui/components.js";

test("tool blocks preview long output and expand on request", () => {
	const output = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
	const block = new ToolBlock("bash", "seq 100", () => {});
	block.setResult({ content: [{ type: "text", text: output }] }, false, 25);
	const collapsed = block.render(80).join("\n");
	assert.match(collapsed, /lines hidden/);
	assert.match(collapsed, /line 1\b/);
	assert.match(collapsed, /line 100\b/);
	assert.doesNotMatch(collapsed, /line 50\b/);

	block.setExpanded(true);
	const expanded = block.render(80).join("\n");
	assert.match(expanded, /line 50\b/);
});

test("tool blocks show errors distinctly", () => {
	const block = new ToolBlock("bash", "false", () => {});
	block.setResult({ content: [{ type: "text", text: "Command exited with code 1" }] }, true, 10);
	const rendered = stripTerminalSequences(block.render(80).join("\n"));
	assert.match(rendered, /\$ false/);
	assert.match(rendered, /error/);
});

test("assistant blocks render text and errors", () => {
	const block = new AssistantBlock(() => {});
	block.setMessage(fauxAssistantMessage("hello", { stopReason: "error", errorMessage: "boom" }), false);
	const rendered = stripTerminalSequences(block.render(80).join("\n"));
	assert.match(rendered, /hello/);
	assert.match(rendered, /error: boom/);
});

test("footer stays compact and truncates at narrow widths", () => {
	const footer = new Footer();
	footer.setState({
		modelRef: "opencode-go/deepseek-v4.1-flash",
		usage: { input: 1234, output: 567, cacheRead: 0, cacheWrite: 0 },
		speed: "42 tok/s",
		context: "ctx 12%",
		sessionId: "01abcdef",
		busy: false,
	});
	const wide = footer.render(120)[0] ?? "";
	assert.match(wide, /opencode-go\/deepseek-v4\.1-flash/);
	assert.match(wide, /in 1\.2k/);
	assert.match(wide, /42 tok\/s/);
	assert.match(wide, /session 01abcdef/);
	assert.match(wide, /ready/);
	const narrow = footer.render(20)[0] ?? "";
	assert.ok(visibleWidth(narrow) <= 20);
});

test("confirmation overlay accepts only explicit allow keys", () => {
	const decisions: boolean[] = [];
	const overlay = new ConfirmOverlay("rm -rf /tmp/x", "recursive forced delete", (allowed) => {
		decisions.push(allowed);
	});
	assert.match(overlay.render(80).join("\n"), /Run this command/);
	overlay.handleInput("n");
	assert.deepEqual(decisions, [false]);

	const allow = new ConfirmOverlay("rm -rf /tmp/x", "recursive forced delete", (allowed) => {
		decisions.push(allowed);
	});
	allow.handleInput("y");
	assert.deepEqual(decisions, [false, true]);
});
