import assert from "node:assert/strict";
import test from "node:test";

test("sessionMarkdown renders a portable transcript", async () => {
	const { sessionMarkdown } = await import("../src/tui/next/export.js");
	const markdown = sessionMarkdown({
		id: "ses_1",
		title: "Build auth",
		agent: "Build",
		model: "openai/gpt-5#high",
		messages: [
			{ id: "m1", role: "user", text: "add oauth", createdAt: 1 },
			{ id: "m2", role: "assistant", text: "Done.", createdAt: 2 },
		],
	});
	assert.match(markdown, /^# Build auth/);
	assert.match(markdown, /- Session: ses_1/);
	assert.match(markdown, /- Agent: Build/);
	assert.match(markdown, /- Model: openai\/gpt-5#high/);
	assert.match(markdown, /## User\n\nadd oauth/);
	assert.match(markdown, /## Assistant\n\nDone\./);
});
