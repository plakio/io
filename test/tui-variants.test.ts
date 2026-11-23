import assert from "node:assert/strict";
import test from "node:test";
import type { EngineModel } from "../src/engine/types.js";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

const model: EngineModel = {
	provider: "openai",
	id: "gpt-5",
	name: "GPT-5",
	contextWindow: 200_000,
	maxTokens: 16_000,
	reasoning: true,
	variants: ["low", "medium", "high"],
	input: ["text"],
	output: ["text"],
};

test("io variant picker selects the effort and keeps the current one", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoVariantPicker } = await import("../src/tui/next/variant-picker.js");

	const setup = await createTestRenderer({ width: 100, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	let selected: string | undefined | "unset" = "unset";
	let closed = 0;
	const picker = new IoVariantPicker({
		renderer: setup.renderer,
		shell,
		model,
		current: "medium",
		onSelect: (variant) => {
			selected = variant;
		},
		onClose: () => {
			closed += 1;
		},
	});

	try {
		picker.open();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Variant · GPT-5/);
		assert.match(frame, /Default/);
		assert.match(frame, /low/);
		assert.match(frame, /medium/);
		assert.match(frame, /high/);
		assert.equal(picker.selectedVariant, "medium");

		picker.move(1);
		assert.equal(picker.selectedVariant, "high");
		assert.equal(picker.selectCurrent(), true);
		assert.equal(selected, "high");
		assert.equal(picker.isOpen, false);
		assert.equal(closed, 1);
	} finally {
		picker.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
