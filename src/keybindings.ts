import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IoPaths } from "./config.js";

export type IoKeybindingOverrides = Readonly<Record<string, readonly string[]>>;

/**
 * Read `~/.config/io/keybindings.json`. Values can be a key string or an array
 * of keys; unknown ids are ignored by the keymap.
 */
export function loadKeybindings(paths: IoPaths): IoKeybindingOverrides {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(paths.configDir, "keybindings.json"), "utf8")) as unknown;
	} catch {
		return {};
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const overrides: Record<string, readonly string[]> = {};
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === "string" && value.trim()) overrides[id] = [value.trim()];
		else if (Array.isArray(value)) {
			const keys = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
			if (keys.length > 0) overrides[id] = keys;
		}
	}
	return overrides;
}
