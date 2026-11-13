import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import {
	AssistantBlock,
	ConfirmOverlay,
	DynamicBorder,
	Footer,
	ModelPicker,
	ToolBlock,
	distinctModelName,
	modelSearchText,
} from "../src/tui/components.js";
import {
	AssistantBlock as PiAssistantBlock,
	ToolBlock as PiToolBlock,
	UserBlock as PiUserBlock,
	footerStatusText,
} from "../src/tui/pi-components.js";
import { initPiVisuals } from "../src/tui/pi-theme.js";

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

const PICKER_ITEMS = [
	{ id: "glm-5.3", provider: "opencode-go", name: "GLM 5.3", contextWindow: 200000 },
	{ id: "kimi-k3", provider: "opencode-go", name: "Kimi K3", contextWindow: 256000 },
];

test("model search finds kimi inside the full provider/model reference", () => {
	assert.match(modelSearchText({ id: "kimi-k3", provider: "opencode-go", name: "Kimi K3" }), /kimi/);
	const filtered = fuzzyFilter(PICKER_ITEMS, "kimi", (item) => modelSearchText(item));
	assert.equal(filtered[0]?.id, "kimi-k3");
	assert.equal(filtered.length, 1);
	const slashed = fuzzyFilter(PICKER_ITEMS, "opencode-go/kimi", (item) => modelSearchText(item));
	assert.equal(slashed[0]?.id, "kimi-k3");
	// Non-defining names stay hidden in rows; distinct ones are kept.
	assert.equal(distinctModelName({ id: "kimi-k3", name: "Kimi K3" }), undefined);
	assert.equal(distinctModelName({ id: "kimi-k3", name: "Moonshot K3 Flagship" }), "Moonshot K3 Flagship");
});

test("model picker filters fuzzy and renders cursor, current marker, and provider", () => {
	const picker = new ModelPicker(PICKER_ITEMS, {
		maxVisible: 5,
		currentValue: "opencode-go/kimi-k3",
		onSelect: () => {},
		onCancel: () => {},
	});
	for (const char of "kimi") picker.handleInput(char);
	const rendered = stripTerminalSequences(picker.render(80).join("\n"));
	assert.match(rendered, /kimi-k3/);
	assert.match(rendered, /✓/);
	assert.match(rendered, /\[opencode-go\]/);
	assert.doesNotMatch(rendered, /glm-5\.3/);
	assert.equal(picker.getSelectedItem()?.id, "kimi-k3");
});

test("model picker selects the filtered model with Enter", () => {
	const selected: string[] = [];
	const picker = new ModelPicker(PICKER_ITEMS, {
		maxVisible: 5,
		onSelect: (item) => selected.push(`${item.provider}/${item.id}`),
		onCancel: () => {},
	});
	for (const char of "kimi") picker.handleInput(char);
	picker.handleInput("\r");
	assert.deepEqual(selected, ["opencode-go/kimi-k3"]);
});

test("model picker moves with Down and shows the no-match state", () => {
	const picker = new ModelPicker(PICKER_ITEMS, {
		maxVisible: 5,
		onSelect: () => {},
		onCancel: () => {},
	});
	assert.equal(picker.getSelectedItem()?.id, "glm-5.3");
	picker.handleInput("\x1b[B");
	assert.equal(picker.getSelectedItem()?.id, "kimi-k3");
	for (const char of "zzz-no-match") picker.handleInput(char);
	const rendered = stripTerminalSequences(picker.render(80).join("\n"));
	assert.match(rendered, /No matching models/);
});

test("model picker swaps items on refresh while keeping the filter", () => {
	const picker = new ModelPicker(PICKER_ITEMS, {
		maxVisible: 5,
		onSelect: () => {},
		onCancel: () => {},
	});
	for (const char of "kimi") picker.handleInput(char);
	assert.equal(picker.getSelectedItem()?.id, "kimi-k3");
	picker.setItems([
		...PICKER_ITEMS,
		{ id: "crouton-alpha-free", provider: "opencode-go", name: "Crouton Alpha Free", contextWindow: 1000000 },
	]);
	// Filter text is untouched, so the new model only appears once it matches.
	assert.equal(picker.getSelectedItem()?.id, "kimi-k3");
	for (let i = 0; i < 4; i++) picker.handleInput("\x7f");
	for (const char of "crout") picker.handleInput(char);
	assert.equal(picker.getSelectedItem()?.id, "crouton-alpha-free");
	const rendered = stripTerminalSequences(picker.render(80).join("\n"));
	assert.match(rendered, /crouton-alpha-free/);
	assert.match(rendered, /\[opencode-go\]/);
});

test("dynamic border fills the viewport width", () => {
	const lines = new DynamicBorder().render(20);
	assert.equal(lines.length, 1);
	assert.equal(stripTerminalSequences(lines[0] ?? "").length, 20);
	assert.match(stripTerminalSequences(lines[0] ?? ""), /^─+$/);
});

test("footer shows live activity counters when non-zero", () => {
	const footer = new Footer();
	footer.setState({
		modelRef: "opencode-go/kimi-k3",
		busy: true,
		status: "running shell",
		spinner: "⠋",
		activity: { commands: 8, edits: 9, reads: 8, thoughts: 5, subagents: 1 },
		totals: { input: 12000, output: 3400, cacheRead: 9000, cacheWrite: 500, total: 15400 },
		cost: 0.42,
		cacheHit: 42,
	});
	const rendered = stripTerminalSequences(footer.render(150).join("\n"));
	assert.match(rendered, /\+8 commands/);
	assert.match(rendered, /\+9 edits/);
	assert.match(rendered, /\+8 reads/);
	assert.match(rendered, /\+5 thoughts/);
	assert.match(rendered, /\+1 subagents/);
	assert.match(rendered, /total 15\.4k/);
	assert.match(rendered, /hit 42%/);
	assert.match(rendered, /\$\d+\.42/);
});

test("footer omits zero activity counters", () => {
	const footer = new Footer();
	footer.setState({ modelRef: "opencode-go/kimi-k3", busy: false, activity: { commands: 0, edits: 0, reads: 0, thoughts: 0, subagents: 0 } });
	const rendered = stripTerminalSequences(footer.render(150).join("\n"));
	assert.doesNotMatch(rendered, /commands/);
	assert.doesNotMatch(rendered, /edits/);
	assert.match(rendered, /ready/);
});

test("footer shows cwd and git branch at the start (Pi style)", () => {
	const footer = new Footer();
	footer.setState({ cwd: "~/io", branch: "main" });
	const rendered = stripTerminalSequences(footer.render(150).join("\n"));
	assert.match(rendered, /~\/io \(main\)/);
	const bare = new Footer();
	bare.setState({ cwd: "~/io" });
	const bareRendered = stripTerminalSequences(bare.render(150).join("\n"));
	assert.match(bareRendered, /~\/io(?! \()/);
});

test("footer shows the spinner frame while busy and omits it when idle", () => {
	const footer = new Footer();
	footer.setState({ modelRef: "opencode-go/kimi-k3", busy: true, status: "generating", spinner: "⠋" });
	const busyLine = footer.render(120)[0] ?? "";
	assert.match(busyLine, /⠋/);
	assert.match(busyLine, /generating/);
	footer.setState({ modelRef: "opencode-go/kimi-k3", busy: false });
	const idleLine = footer.render(120)[0] ?? "";
	assert.match(idleLine, /ready/);
	assert.doesNotMatch(idleLine, /⠋/);
});

test("pi components render user, assistant and bash blocks", () => {
	initPiVisuals();
	const user = new PiUserBlock("hola desde el usuario");
	const userRendered = user.render(60).join("\n");
	assert.match(stripTerminalSequences(userRendered), /hola desde el usuario/);
	assert.doesNotMatch(userRendered, /\x1b\]133;/);

	const assistant = new PiAssistantBlock(() => {});
	assistant.setMessage(fauxAssistantMessage("hola desde el asistente"), false);
	const assistantRendered = stripTerminalSequences(assistant.render(60).join("\n"));
	assert.match(assistantRendered, /hola desde el asistente/);

	const ui = { requestRender() {} } as unknown as TUI;
	const tool = new PiToolBlock({
		toolName: "bash",
		toolCallId: "test-1",
		args: { command: "echo hola" },
		cwd: process.cwd(),
		ui,
		toolDefinition: createBashToolDefinition(process.cwd()),
	});
	tool.markStarted();
	tool.setResult({ content: [{ type: "text", text: "hola" }] }, false, 5);
	const toolRendered = stripTerminalSequences(tool.render(60).join("\n"));
	assert.match(toolRendered, /\$ echo hola/);
	assert.match(toolRendered, /hola/);
});

test("footer status line shows only tok/s", () => {
	assert.equal(
		footerStatusText({ busy: true, status: "running shell", speed: "42 tok/s", queued: 2 }),
		"42 tok/s",
	);
	assert.equal(footerStatusText({ busy: true, status: "running shell", queued: 2 }), undefined);
});
