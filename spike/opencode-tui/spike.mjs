import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/sdk";
import { Model, Plugin, Provider } from "@opencode/plugin";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { startMockModelServer } from "./mock-server.mjs";

const runDir = mkdtempSync(join(tmpdir(), "io-spike-"));
const resultsPath = process.env.IO_SPIKE_RESULTS ?? join(process.cwd(), "results.json");
const configDir = join(runDir, "config");
mkdirSync(configDir, { recursive: true });
const providerID = Provider.ID.make("mock");
const modelID = Model.ID.make("mock-1");

function createMockPlugin(baseURL) {
	return Plugin.define({
		id: "io-spike-mock-provider",
		async setup(ctx) {
			await ctx.provider.transform((editor) => {
				editor.add({
					info: {
						...Provider.Info.empty(providerID),
						name: "Mock provider",
						activation: "enabled",
						package: "@opencode/ai/providers/openai-compatible",
						settings: { baseURL },
					},
					models: [
						{
							...Model.Info.default(providerID, modelID),
							name: "Mock 1",
						},
					],
				});
			});
		},
	});
}

function withTimeout(promise, ms, label) {
	return Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
	]);
}

const mark = (name) => ({ name, at: performance.now() });

async function main() {
	const marks = [];
	const events = [];
	let text = "";
	let finalText = "";
	let rendererSetup;

	const server = await startMockModelServer();
	marks.push(mark("mock-server-ready"));

	try {
		rendererSetup = await createTestRenderer({ width: 82, height: 20 });
		const { renderer, renderOnce, captureCharFrame } = rendererSetup;
		const panel = new BoxRenderable(renderer, {
			border: true,
			title: "io · spike",
			flexDirection: "column",
			padding: 1,
			width: "100%",
			height: "100%",
		});
		panel.add(new TextRenderable(renderer, { content: "OpenCode SDK + OpenTUI", fg: "#8bd5ff" }));
		panel.add(new TextRenderable(renderer, { content: "" }));
		const output = new TextRenderable(renderer, { content: "waiting…", fg: "#d7d7d7" });
		panel.add(output);
		renderer.root.add(panel);
		marks.push(mark("opentui-ready"));

		const host = await OpenCode.create({
			app: { name: "io-spike", version: "0.0.0" },
			database: { path: join(runDir, "spike.db") },
			config: { directory: configDir, project: false, claude: false },
			models: { fetch: false },
			plugins: [createMockPlugin(server.url)],
			log: { level: "error" },
		});
		marks.push(mark("opencode-host-ready"));

		const session = await host.sessions.create({ location: { directory: process.cwd() } });
		await host.sessions.switchModel({
			sessionID: session.id,
			model: { providerID, id: modelID },
		});
		marks.push(mark("session-ready"));

		const controller = new AbortController();
		const done = new Promise((resolve) => {
			void (async () => {
				try {
					for await (const event of host.events.subscribe({ signal: controller.signal })) {
						events.push(event.type);
						if (event.type === "session.text.delta") {
							text += event.data.delta;
							output.content = text;
						}
						if (event.type === "permission.asked") {
							await host.permission.reply({
								sessionID: event.data.sessionID,
								requestID: event.data.id,
								decision: "reject",
							});
						}
						if (
							event.type === "session.execution.succeeded" ||
							event.type === "session.execution.failed" ||
							event.type === "session.idle"
						) {
							resolve(event);
							return;
						}
					}
				} catch (error) {
					if (!controller.signal.aborted) resolve({ type: "stream-error", error: String(error) });
				}
			})();
		});

		const promptStarted = performance.now();
		await host.sessions.prompt({ sessionID: session.id, text: "Say hello to io" });
		await withTimeout(done, 20_000, "prompt");
		marks.push(mark("prompt-done"));
		const promptMs = performance.now() - promptStarted;

		const context = await host.sessions.context({ sessionID: session.id });
		const assistant = context.filter((message) => message.type === "assistant").at(-1);
		if (assistant && Array.isArray(assistant.content)) {
			finalText = assistant.content
				.filter((part) => part && part.type === "text")
				.map((part) => part.text)
				.join("");
		}
		output.content = text || finalText || "(no text)";
		await renderOnce();
		const frame = captureCharFrame();
		marks.push(mark("render-captured"));

		const result = {
			ok: Boolean(text || finalText),
			text: text || finalText,
			eventTypes: [...new Set(events)],
			timings: {
				hostCreateMs: Math.round(
					marks.find((m) => m.name === "opencode-host-ready").at - marks.find((m) => m.name === "opentui-ready").at,
				),
				promptMs: Math.round(promptMs),
				totalMs: Math.round(marks.at(-1).at - marks[0].at),
			},
			rssMB: Math.round(process.memoryUsage().rss / 1048576),
			frame,
		};
		writeFileSync(resultsPath, `${JSON.stringify(result, null, 2)}\n`);
		console.log(JSON.stringify(result, null, 2));

		controller.abort();
		await host.close();
	} finally {
		await rendererSetup?.dispose();
		await server.close();
		rmSync(runDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error?.stack ?? error);
	process.exitCode = 1;
});
