import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, type Api, type Model } from "@earendil-works/pi-ai";
import { runHeadless } from "../src/main.js";
import { isOutputBroken, markOutputBroken, setOutputBrokenHandler } from "../src/io-streams.js";
import type { AvailableModels } from "../src/runtime.js";
import { createFauxHarness, temporaryPaths } from "./helpers.js";

function fauxModels(model: Model<Api>): AvailableModels {
	return {
		models: [model],
		errors: new Map(),
		providers: [model.provider],
		providerNames: new Map([[model.provider, model.provider]]),
	};
}

test("a closed output stream aborts and disposes the headless session", async () => {
	const temporary = temporaryPaths("io-output-broken-");
	const harness = await createFauxHarness({ paths: temporary.paths });
	try {
		const model = harness.faux.getModel();
		harness.faux.setResponses([fauxAssistantMessage("text that would go to head")]);
		let brokenCalls = 0;
		const code = await runHeadless(
			{
				prompt: "say hello",
				continueSession: false,
				readStdin: false,
				savePreference: false,
			},
			{
				paths: temporary.paths,
				runtime: harness.runtime,
				models: fauxModels(model),
				harness: harness.harness,
				stdout: () => {
					brokenCalls += 1;
					markOutputBroken();
				},
			},
		);
		assert.equal(code, 0);
		assert.equal(brokenCalls > 0, true);
		assert.equal(isOutputBroken(), true);
	} finally {
		setOutputBrokenHandler(undefined);
		temporary.cleanup();
	}
});
