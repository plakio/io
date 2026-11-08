import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { listSessions } from "../src/session.js";
import { createFauxHarness, textEvents, toolResultText } from "./helpers.js";

test("a prompt streams text through the Pi session", async () => {
	const harness = await createFauxHarness();
	try {
		const events = textEvents(harness.harness);
		harness.faux.setResponses([fauxAssistantMessage("hello from the faux provider")]);
		assert.match(harness.harness.session.systemPrompt, /You are IO/);
		assert.doesNotMatch(harness.harness.session.systemPrompt, /Pi documentation/);
		await harness.harness.session.prompt("say hello");
		events.unsubscribe();
		assert.deepEqual(harness.harness.session.getActiveToolNames(), ["bash"]);
		assert.equal(harness.harness.session.getLastAssistantText(), "hello from the faux provider");
		assert.equal(events.deltas.join(""), "hello from the faux provider");
		assert.ok(events.deltas.length > 0);
		const stats = harness.harness.session.getSessionStats();
		assert.ok(stats.tokens.output > 0);
	} finally {
		harness.harness.session.dispose();
		harness.cleanup();
	}
});

test("the bash tool executes and its output reaches the model", async () => {
	const harness = await createFauxHarness();
	try {
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'io-bash-ok'" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("command finished"),
		]);
		await harness.harness.session.prompt("run a command");
		assert.match(toolResultText(harness.harness), /io-bash-ok/);
		assert.equal(harness.harness.session.getLastAssistantText(), "command finished");
		const stats = harness.harness.session.getSessionStats();
		assert.equal(stats.toolCalls, 1);
		assert.equal(stats.toolResults, 1);
	} finally {
		harness.harness.session.dispose();
		harness.cleanup();
	}
});

test("dangerous commands are blocked when confirmation is denied", async () => {
	const marker = mkdtempSync(join(tmpdir(), "io-danger-"));
	mkdirSync(marker, { recursive: true });
	const confirmations: string[] = [];
	const harness = await createFauxHarness({
		confirmCommand: async (request) => {
			confirmations.push(request.command);
			return false;
		},
	});
	try {
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: `rm -rf ${marker}` }), { stopReason: "toolUse" }),
			fauxAssistantMessage("the command was not run"),
		]);
		await harness.harness.session.prompt("delete the marker");
		assert.deepEqual(confirmations, [`rm -rf ${marker}`]);
		assert.match(toolResultText(harness.harness), /denied permission/i);
		assert.equal(existsSync(marker), true);
		assert.equal(harness.harness.session.getLastAssistantText(), "the command was not run");
	} finally {
		harness.harness.session.dispose();
		harness.cleanup();
		rmSync(marker, { recursive: true, force: true });
	}
});

test("provider API keys are not inherited by bash commands", async () => {
	const previous = process.env.OPENCODE_API_KEY;
	process.env.OPENCODE_API_KEY = "io-test-secret";
	const harness = await createFauxHarness();
	try {
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "env | grep '^OPENCODE_API_KEY=' || echo NOT-PRESENT" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("checked"),
		]);
		await harness.harness.session.prompt("check the environment");
		assert.match(toolResultText(harness.harness), /NOT-PRESENT/);
		assert.doesNotMatch(toolResultText(harness.harness), /io-test-secret/);
	} finally {
		if (previous === undefined) delete process.env.OPENCODE_API_KEY;
		else process.env.OPENCODE_API_KEY = previous;
		harness.harness.session.dispose();
		harness.cleanup();
	}
});

test(
	"generation can be cancelled",
	{ timeout: 10_000 },
	async () => {
		const harness = await createFauxHarness({ tokensPerSecond: 80 });
		try {
			const events = textEvents(harness.harness);
			harness.faux.setResponses([fauxAssistantMessage("word ".repeat(200))]);
			const prompt = harness.harness.session.prompt("stream for a while");
			await new Promise<void>((resolve) => {
				const unsubscribe = harness.harness.session.subscribe((event) => {
					if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
						unsubscribe();
						resolve();
					}
				});
			});
			await harness.harness.session.abort();
			await prompt;
			events.unsubscribe();
			assert.equal(harness.harness.session.isStreaming, false);
		} finally {
			harness.harness.session.dispose();
			harness.cleanup();
		}
	},
);

test(
	"a running bash command can be cancelled",
	{ timeout: 10_000 },
	async () => {
		const harness = await createFauxHarness();
		try {
			harness.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("should not be reached"),
			]);
			const started = Date.now();
			const prompt = harness.harness.session.prompt("start a long command");
			await new Promise<void>((resolve) => {
				const unsubscribe = harness.harness.session.subscribe((event) => {
					if (event.type === "tool_execution_start") {
						unsubscribe();
						resolve();
					}
				});
			});
			await harness.harness.session.abort();
			await prompt;
			const elapsed = Date.now() - started;
			assert.ok(elapsed < 5000, `cancellation took ${elapsed}ms`);
			assert.equal(harness.harness.session.isStreaming, false);
		} finally {
			harness.harness.session.dispose();
			harness.cleanup();
		}
	},
);

test("sessions persist and can be continued", async () => {
	const first = await createFauxHarness();
	const paths = first.paths;
	try {
		first.faux.setResponses([fauxAssistantMessage("remember this")]);
		await first.harness.session.prompt("first message");
		assert.ok(first.harness.session.sessionFile);
		assert.equal(existsSync(first.harness.session.sessionFile), true);
		const sessions = await listSessions(paths, process.cwd());
		assert.ok(sessions.length >= 1);
		first.harness.session.dispose();

		const second = await createFauxHarness({ paths, continueSession: true });
		try {
			assert.equal(second.harness.session.messages.some((message) => message.role === "user"), true);
			const text = second.harness.session.messages
				.filter((message) => message.role === "user")
				.map((message) => {
					if (typeof message.content === "string") return message.content;
					return message.content
						.map((block) => (block.type === "text" ? block.text : ""))
						.filter((part) => part.length > 0)
						.join("\n");
				})
				.join("\n");
			assert.match(text, /first message/);
		} finally {
			second.harness.session.dispose();
		}
	} finally {
		first.cleanup();
	}
});
