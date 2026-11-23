import { createServer } from "node:http";

/** Minimal OpenAI-compatible streaming endpoint for engine tests. */
export async function startMockModelServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((request, response) => {
		if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "not found" } }));
			return;
		}

		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
				model?: string;
				messages?: Array<{ role?: unknown; content?: unknown }>;
			};
			const messages = Array.isArray(body.messages) ? body.messages : [];
			const prompt = messages
				.map((message) => message.content)
				.filter((value): value is string => typeof value === "string")
				.join(" ");
			const hasToolResult = messages.some((message) => message.role === "tool");
			const wantsTool = !hasToolResult && prompt.includes("run tool");
			const text = hasToolResult ? "Tool finished." : `Hello from mock. Prompt: ${prompt.slice(0, 40)}`;

			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const base = {
				id: "chatcmpl-io-test",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: body.model ?? "mock-1",
			};
			const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
			if (wantsTool) {
				send({
					...base,
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: "call_io_test",
										type: "function",
										function: {
											name: "shell",
											arguments: JSON.stringify({ command: "echo io-tool-test" }),
										},
									},
								],
							},
							finish_reason: null,
						},
					],
				});
				send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
			} else {
				send({
					...base,
					choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
				});
				send({
					...base,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
				});
			}
			response.write("data: [DONE]\n\n");
			response.end();
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("could not bind mock model server");
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

export async function createMockPlugin(baseURL: string): Promise<unknown> {
	const { Model, Plugin, Provider } = await import("@opencode/plugin");
	const providerID = Provider.ID.make("mock");
	const modelID = Model.ID.make("mock-1");
	return Plugin.define({
		id: "io-test-mock-provider",
		async setup(ctx: unknown) {
			const context = ctx as {
				provider: { transform(callback: (editor: unknown) => Promise<void>): Promise<void> };
			};
			await context.provider.transform(async (rawEditor) => {
				const editor = rawEditor as {
					add(input: {
						info: unknown;
						models: Array<unknown>;
					}): void;
				};
				editor.add({
					info: {
						...Provider.Info.empty(providerID),
						name: "Mock provider",
						activation: "enabled",
						package: "@opencode/ai/providers/openai-compatible",
						settings: { baseURL },
					},
					models: [{ ...Model.Info.default(providerID, modelID), name: "Mock 1" }],
				});
			});
		},
	});
}
