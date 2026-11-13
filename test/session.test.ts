import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { listSessions } from "../src/session.js";
import { saveConfig, loadConfig } from "../src/config.js";
import { createFauxHarness, temporaryPaths, textEvents, toolResultText } from "./helpers.js";

test("context files and project skills load only when enabled", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "io-context-"));
	mkdirSync(join(cwd, ".agents", "skills", "demo"), { recursive: true });
	writeFileSync(join(cwd, "AGENTS.md"), "PROJECT-CONTEXT-MARKER\n");
	writeFileSync(
		join(cwd, ".agents", "skills", "demo", "SKILL.md"),
		"---\nname: demo-skill\ndescription: Demo skill marker\n---\n\n# Demo\n",
	);
	try {
		const off = await createFauxHarness({ cwd });
		try {
			assert.doesNotMatch(off.harness.session.systemPrompt, /PROJECT-CONTEXT-MARKER/);
			assert.doesNotMatch(off.harness.session.systemPrompt, /demo-skill/);
		} finally {
			off.harness.session.dispose();
			off.cleanup();
		}

		const on = await createFauxHarness({ cwd, context: { skills: true, contextFiles: true } });
		try {
			assert.match(on.harness.session.systemPrompt, /PROJECT-CONTEXT-MARKER/);
			assert.match(on.harness.session.systemPrompt, /demo-skill/);
			assert.match(on.harness.session.systemPrompt, /Demo skill marker/);
			assert.deepEqual(on.harness.context, { skills: true, contextFiles: true });
		} finally {
			on.harness.session.dispose();
			on.cleanup();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a prompt streams text through the Pi session", async () => {
	const harness = await createFauxHarness();
	try {
		const events = textEvents(harness.harness);
		harness.faux.setResponses([fauxAssistantMessage("hello from the faux provider")]);
		assert.match(harness.harness.session.systemPrompt, /You are IO/);
		assert.doesNotMatch(harness.harness.session.systemPrompt, /Pi documentation/);
		// Auto-compaction is a Pi session feature; io relies on its defaults.
		assert.equal(harness.harness.settingsManager.getCompactionEnabled(), true);
		assert.equal(
			harness.harness.settingsManager.getCompactionSettings(harness.harness.session.model).enabled,
			true,
		);
		await harness.harness.session.prompt("say hello");
		events.unsubscribe();
		assert.deepEqual(harness.harness.session.getActiveToolNames(), ["bash", "subagent"]);
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

test("models.json credential environment variables are not inherited by bash commands", async () => {
	const previous = process.env.FIFTYX_API_KEY;
	process.env.FIFTYX_API_KEY = "50x-test-secret";
	const temporary = temporaryPaths("io-custom-provider-");
	writeFileSync(
		join(temporary.paths.dataDir, "models.json"),
		`${JSON.stringify({
			providers: {
				"50x": {
					baseUrl: "https://example.invalid/v1",
					api: "openai-completions",
					apiKey: "$FIFTYX_API_KEY",
					models: [{ id: "test-model" }],
				},
			},
		})}\n`,
	);
	const harness = await createFauxHarness({ paths: temporary.paths });
	try {
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "env | grep '^FIFTYX_API_KEY=' || echo NOT-PRESENT" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("checked"),
		]);
		await harness.harness.session.prompt("check the environment");
		assert.match(toolResultText(harness.harness), /NOT-PRESENT/);
		assert.doesNotMatch(toolResultText(harness.harness), /50x-test-secret/);
	} finally {
		if (previous === undefined) delete process.env.FIFTYX_API_KEY;
		else process.env.FIFTYX_API_KEY = previous;
		harness.harness.session.dispose();
		temporary.cleanup();
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
		assert.equal(statSync(first.harness.session.sessionFile).mode & 0o777, 0o600);
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

test("editing config mid-session does not change the active permission policy", async () => {
	const temporary = temporaryPaths();
	saveConfig(temporary.paths, { permissionMode: "ask" });
	const marker = mkdtempSync(join(tmpdir(), "io-escalation-"));
	writeFileSync(join(marker, "file.txt"), "x");
	const confirmations: string[] = [];
	const harness = await createFauxHarness({
		paths: temporary.paths,
		confirmCommand: async (request) => {
			confirmations.push(request.command);
			return false;
		},
	});
	try {
		const configWrite = `printf '%s' '{"permissionMode":"auto"}' > '${temporary.paths.configPath}'`;
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: configWrite }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bash", { command: `rm -rf ${marker}` }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.harness.session.prompt("try to escalate");
		assert.equal(loadConfig(temporary.paths).config.permissionMode, "auto");
		assert.equal(harness.harness.getPermissionMode(), "ask");
		assert.ok(confirmations.some((command) => command.includes("rm -rf")));
		assert.equal(existsSync(marker), true);
	} finally {
		harness.harness.session.dispose();
		harness.cleanup();
		temporary.cleanup();
		rmSync(marker, { recursive: true, force: true });
	}
});

test("a general subagent inherits the parent permission snapshot", async () => {
	const temporary = temporaryPaths();
	saveConfig(temporary.paths, { permissionMode: "ask" });
	const marker = mkdtempSync(join(tmpdir(), "io-subagent-escalation-"));
	writeFileSync(join(marker, "file.txt"), "x");
	const confirmations: string[] = [];
	const harness = await createFauxHarness({
		paths: temporary.paths,
		confirmCommand: async (request) => {
			confirmations.push(request.command);
			return false;
		},
	});
	try {
		const configWrite = `printf '%s' '{"permissionMode":"auto"}' > '${temporary.paths.configPath}'`;
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: configWrite }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("subagent", { agent: "general", task: "delete the marker" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("bash", { command: `rm -rf ${marker}` }), { stopReason: "toolUse" }),
			fauxAssistantMessage("subagent blocked"),
			fauxAssistantMessage("parent done"),
		]);
		await harness.harness.session.prompt("delegate the escalation");
		assert.ok(confirmations.some((command) => command.includes("rm -rf")));
		assert.equal(existsSync(marker), true);
		assert.equal(harness.harness.getPermissionMode(), "ask");
	} finally {
		harness.harness.session.dispose();
		harness.cleanup();
		temporary.cleanup();
		rmSync(marker, { recursive: true, force: true });
	}
});

test("applyConfig and addPermissionRule update the in-memory policy", async () => {
	const harness = await createFauxHarness();
	try {
		assert.equal(harness.harness.getPermissionMode(), "ask");
		harness.harness.applyConfig({
			permissionMode: "auto",
			permissions: [{ resource: "rm -rf build", effect: "deny" }],
		});
		assert.equal(harness.harness.getPermissionMode(), "auto");
		assert.deepEqual(harness.harness.getPermissionRules(), [{ resource: "rm -rf build", effect: "deny" }]);
		assert.equal(harness.harness.addPermissionRule({ resource: "git status *", effect: "allow" }), true);
		assert.equal(harness.harness.addPermissionRule({ resource: "git status *", effect: "allow" }), false);
		assert.equal(harness.harness.getPermissionRules().length, 2);
	} finally {
		harness.harness.session.dispose();
		harness.cleanup();
	}
});

test("readonly harness blocks shell writes even when they are not risky", async () => {
	const temporary = temporaryPaths();
	const marker = join(temporary.paths.dataDir, "readonly-marker");
	const harness = await createFauxHarness({ paths: temporary.paths, readonly: true });
	try {
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: `echo nope > '${marker}'` }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("blocked"),
		]);
		await harness.harness.session.prompt("try to write");
		assert.equal(existsSync(marker), false);
		assert.match(toolResultText(harness.harness), /read-only/i);
	} finally {
		harness.harness.session.dispose();
		temporary.cleanup();
	}
});

test("subagent tool delegates to a fresh in-memory session", async () => {
	const harness = await createFauxHarness();
	try {
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { agent: "general", task: "say hi" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("subagent summary"),
			fauxAssistantMessage("parent done"),
		]);
		await harness.harness.session.prompt("delegate");
		assert.equal(harness.harness.session.getLastAssistantText(), "parent done");
		assert.match(toolResultText(harness.harness), /subagent summary/);
		// Only the parent session is persisted; scratch work stays out of /resume.
		const sessions = await listSessions(harness.paths, process.cwd());
		assert.equal(sessions.length, 1);
	} finally {
		harness.harness.session.dispose();
		harness.cleanup();
	}
});

test("auto permission mode runs dangerous commands without asking", async () => {
	const marker = mkdtempSync(join(tmpdir(), "io-auto-"));
	mkdirSync(marker, { recursive: true });
	writeFileSync(join(marker, "file.txt"), "x");
	const temporary = temporaryPaths();
	saveConfig(temporary.paths, { permissionMode: "auto" });
	const confirmations: string[] = [];
	const harness = await createFauxHarness({
		paths: temporary.paths,
		confirmCommand: async (request) => {
			confirmations.push(request.command);
			return false;
		},
	});
	try {
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: `rm -rf ${marker}` }), { stopReason: "toolUse" }),
			fauxAssistantMessage("deleted"),
		]);
		await harness.harness.session.prompt("delete the marker");
		assert.deepEqual(confirmations, []);
		assert.equal(existsSync(marker), false);
	} finally {
		harness.harness.session.dispose();
		temporary.cleanup();
		rmSync(marker, { recursive: true, force: true });
	}
});

test("commands blocked without an approval channel are reported through notify", async () => {
	const notices: string[] = [];
	const harness = await createFauxHarness({ notify: (message) => notices.push(message) });
	try {
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf /tmp/io-no-channel" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("not run"),
		]);
		await harness.harness.session.prompt("try a destructive command");
		assert.equal(notices.length, 1);
		assert.match(notices[0] ?? "", /blocked without approval channel/);
		assert.match(toolResultText(harness.harness), /no way to ask the user for approval/);
	} finally {
		harness.harness.session.dispose();
		harness.cleanup();
	}
});
