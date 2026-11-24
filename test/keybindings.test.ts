import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IoPaths } from "../src/config.js";

test("loadKeybindings reads user overrides and ignores invalid entries", async () => {
	const { loadKeybindings } = await import("../src/keybindings.js");
	const root = mkdtempSync(join(tmpdir(), "io-keys-"));
	const paths = { configDir: root } as IoPaths;
	try {
		writeFileSync(
			join(root, "keybindings.json"),
			JSON.stringify({
				"model.list": "ctrl+m",
				"session.new": ["ctrl+n", "ctrl+shift+n"],
				"app.exit": "",
				"bad": 42,
			}),
		);
		const overrides = loadKeybindings(paths);
		assert.deepEqual(overrides["model.list"], ["ctrl+m"]);
		assert.deepEqual(overrides["session.new"], ["ctrl+n", "ctrl+shift+n"]);
		assert.equal(overrides["app.exit"], undefined);
		assert.equal(overrides.bad, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("createIoCommands applies keybinding overrides", async () => {
	const { createIoCommands } = await import("../src/tui/next/commands.js");
	const commands = createIoCommands({}, { "model.list": ["ctrl+m"] });
	const model = commands.find((command) => command.id === "model.list");
	assert.deepEqual(model?.keys, ["ctrl+m"]);
});
