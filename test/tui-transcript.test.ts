import assert from "node:assert/strict";
import test from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

test("io transcript renders messages, markdown, tools, thinking and notices", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoTranscript } = await import("../src/tui/next/transcript.js");
	const { ioDarkTheme } = await import("../src/tui/next/theme.js");

	const setup = await createTestRenderer({ width: 100, height: 30 });
	const shell = new IoShell(setup.renderer, {
		cwd: "/home/oscar/project",
		version: "0.2.0",
		branch: "main",
		sessionID: "3f2a",
	});
	const transcript = new IoTranscript({
		renderer: setup.renderer,
		container: shell.transcriptContainer,
		theme: ioDarkTheme,
		showThinking: true,
	});

	try {
		transcript.addUser("refactor the auth flow");
		transcript.apply({ type: "text_started", sessionID: "s", messageID: "m1" });
		for (const delta of ["## Plan\n\n", "- inspect auth\n", "- patch login\n\n", "```ts\nexport function login() {}\n```\n"]) {
			transcript.apply({ type: "text_delta", sessionID: "s", messageID: "m1", delta });
		}
		transcript.apply({ type: "text_ended", sessionID: "s", messageID: "m1" });
		transcript.apply({ type: "reasoning_started", sessionID: "s", messageID: "m1" });
		transcript.apply({
			type: "reasoning_delta",
			sessionID: "s",
			messageID: "m1",
			delta: "secret reasoning",
		});
		transcript.apply({ type: "reasoning_ended", sessionID: "s", messageID: "m1" });

		transcript.apply({
			type: "tool_started",
			sessionID: "s",
			toolCallID: "t1",
			name: "shell",
		});
		transcript.apply({
			type: "tool_called",
			sessionID: "s",
			toolCallID: "t1",
			input: { command: "rg auth src" },
		});
		transcript.apply({
			type: "tool_finished",
			sessionID: "s",
			toolCallID: "t1",
			status: "success",
			content: [{ type: "text", text: "src/auth.ts:42" }],
		});
		transcript.addNotice("context compacted", "success");

		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /user/);
		assert.match(frame, /refactor the auth flow/);
		assert.match(frame, /Plan/);
		assert.match(frame, /inspect auth/);
		assert.match(frame, /secret reasoning/);
		assert.match(frame, /bash/);
		assert.match(frame, /rg auth src/);
		assert.match(frame, /src\/auth\.ts:42/);
		assert.match(frame, /export function login/);
		assert.match(frame, /context compacted/);

		transcript.setToolOutputExpanded(false);
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /src\/auth\.ts:42/);
		transcript.setToolOutputExpanded(true);
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /src\/auth\.ts:42/);

		transcript.setShowThinking(false);
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /secret reasoning/);

		for (let index = 0; index < 30; index++) transcript.addUser(`history ${index}`);
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /history 29/);

		transcript.clear();
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /refactor the auth flow/);
	} finally {
		transcript.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
