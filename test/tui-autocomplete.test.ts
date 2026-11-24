import assert from "node:assert/strict";
import test from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

test("io autocomplete shows commands and files, navigates and accepts", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoAutocomplete } = await import("../src/tui/next/autocomplete.js");

	const setup = await createTestRenderer({ width: 100, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	const accepted: string[] = [];
	const autocomplete = new IoAutocomplete({
		renderer: setup.renderer,
		shell,
		completions: [
			{ value: "/help", description: "Show commands and keys", kind: "command" },
			{ value: "/model", description: "Select a model", kind: "command" },
			{ value: "/models", description: "List available models", kind: "command" },
			{ value: "/new", description: "Start a new session", kind: "command" },
		],
		cwd: () => "/home/oscar/project",
		workspaceFiles: async () => ["src/tui/app.ts", "src/engine/opencode.ts", "README.md"],
		agents: () => [{ id: "general", name: "General", description: "Multi-step work" }],
		onAccept: (text) => accepted.push(text),
	});

	try {
		autocomplete.update("/m");
		await setup.renderOnce();
		const commands = setup.captureCharFrame();
		assert.match(commands, /Commands/);
		assert.match(commands, /\/model/);
		assert.match(commands, /\/models/);

		autocomplete.handleKey({ name: "down" });
		await setup.renderOnce();
		assert.equal(autocomplete.selectedMatch?.value, "/models");
		autocomplete.handleKey({ name: "tab" });
		assert.deepEqual(accepted, ["/models "]);
		assert.equal(autocomplete.visible, false);

		autocomplete.update("@app");
		let filesFrame = "";
		for (let attempt = 0; attempt < 40; attempt++) {
			await setup.renderOnce();
			filesFrame = setup.captureCharFrame();
			if (filesFrame.includes("src/tui/app.ts")) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.match(filesFrame, /Files/);
		assert.match(filesFrame, /src\/tui\/app\.ts/);
		autocomplete.handleKey({ name: "tab" });
		assert.match(accepted[1] ?? "", /@src\/tui\/app\.ts /);

		autocomplete.update("/he");
		assert.equal(autocomplete.visible, true);
		autocomplete.handleKey({ name: "escape" });
		assert.equal(autocomplete.visible, false);
		autocomplete.update("@gen");
		let agentFrame = "";
		for (let attempt = 0; attempt < 40; attempt++) {
			await setup.renderOnce();
			agentFrame = setup.captureCharFrame();
			if (agentFrame.includes("General")) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.match(agentFrame, /agent · Multi-step work/);
		autocomplete.handleKey({ name: "tab" });
		assert.match(accepted.at(-1) ?? "", /@general /);

		autocomplete.update("/he");
		assert.equal(autocomplete.visible, true);
		autocomplete.handleKey({ name: "escape" });
		assert.equal(autocomplete.visible, false);
		autocomplete.update("/he");
		assert.equal(autocomplete.visible, false, "escape keeps the same text dismissed");
		autocomplete.update("/help");
		assert.equal(autocomplete.visible, true, "new text reopens the menu");
	} finally {
		autocomplete.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
