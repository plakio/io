import type { ShellPermissionRule } from "../config.js";
import type { EnginePermissionRule } from "./types.js";

/**
 * io rules are shell-only and use `{ resource, effect }`. OpenCode V2 adds an
 * action and currently evaluates shell commands under `action: "shell"`.
 */
export function toEnginePermissionRules(
	rules: readonly ShellPermissionRule[],
): EnginePermissionRule[] {
	return rules.map((rule) => ({
		action: "shell",
		resource: rule.resource,
		effect: rule.effect,
	}));
}
