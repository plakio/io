import assert from "node:assert/strict";
import test from "node:test";
import type { EngineModel } from "../src/engine/types.js";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

function model(
	provider: string,
	id: string,
	name: string,
	contextWindow: number,
	variants: string[] = [],
): EngineModel {
	return {
		provider,
		id,
		name,
		contextWindow,
		maxTokens: 8192,
		reasoning: variants.length > 0,
		variants,
		input: ["text"],
		output: ["text"],
		cost: { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0.1 },
	};
}

test("io model picker groups, filters, favorites, cycles variants and selects", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoModelPicker } = await import("../src/tui/next/model-picker.js");

	const setup = await createTestRenderer({ width: 120, height: 30 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	const favorites: Array<[string, boolean]> = [];
	let selected: { model: string; variant?: string } | undefined;
	let closed = 0;
	const picker = new IoModelPicker({
		renderer: setup.renderer,
		shell,
		models: [
			model("alpha", "a-1", "Alpha One", 200_000, ["low", "high"]),
			model("alpha", "a-2", "Alpha Two", 128_000),
			model("beta", "b-1", "Beta One", 1_000_000),
		],
		current: { provider: "alpha", id: "a-1", variant: "low" },
		favorites: ["alpha/a-1"],
		recent: ["beta/b-1"],
		onSelect: (entry, variant) => {
			selected = { model: `${entry.provider}/${entry.id}`, ...(variant ? { variant } : {}) };
		},
		onFavoriteChange: (key, favorite) => favorites.push([key, favorite]),
		onClose: () => {
			closed += 1;
		},
	});

	try {
		picker.open();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Models/);
		assert.match(frame, /Recent/);
		assert.match(frame, /Alpha One/);
		assert.match(frame, /Beta One/);
		assert.match(frame, /200k/);
		assert.match(frame, /\$0\.50\/\$1\.50/);

		picker.setQuery("alpha");
		await setup.renderOnce();
		assert.equal(picker.selectedModel?.id, "a-1");
		const before = picker.selectedVariant;
		assert.equal(picker.cycleVariant(), true);
		assert.notEqual(picker.selectedVariant, before);
		assert.equal(picker.toggleFavorite(), true);
		assert.deepEqual(favorites.at(-1), ["alpha/a-1", false]);

		picker.setQuery("");
		assert.equal(picker.nextProvider(), true);
		assert.equal(picker.selectedModel?.provider, "alpha");
		assert.equal(picker.selectCurrent(), true);
		assert.equal(selected?.model, "alpha/a-1");
		assert.equal(closed, 1);
		assert.equal(picker.isOpen, false);
	} finally {
		picker.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
