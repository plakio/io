import { createServer } from "node:http";

/**
 * Minimal OpenAI-compatible chat completions endpoint.
 * It streams one assistant text delta and a stop chunk, enough for the
 * OpenCode provider/runtime path without credentials or network access.
 */
export async function startMockModelServer() {
	const server = createServer((request, response) => {
		if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "not found" } }));
			return;
		}

		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			const prompt = Array.isArray(body.messages)
				? body.messages.map((message) => message.content).filter((value) => typeof value === "string").join(" ")
				: "";
			const text = `Hello from the mock provider. You said: ${prompt.slice(0, 80)}`;

			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});

			const base = {
				id: "chatcmpl-io-spike",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: body.model ?? "mock-1",
			};
			const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);

			send({
				...base,
				choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
			});
			send({
				...base,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
			});
			response.write("data: [DONE]\n\n");
			response.end();
		});
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("could not bind mock model server");
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
