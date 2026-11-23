import {
	PERMISSION_MODES,
	THINKING_LEVELS,
	VERBOSITY_LEVELS,
	loadConfig,
	resolvePermissionMode,
	saveConfig,
	type IoAppearanceConfig,
	type IoConfig,
	type IoPaths,
	type IoThemePreference,
} from "../config.js";
import { CliError } from "../errors.js";
import { formatTokens } from "../format.js";
import type { AgentEngine } from "../engine/types.js";

export interface ConfigOutput {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

export interface ConfigPrompt {
	select(
		message: string,
		options: Array<{ id: string; label: string; description?: string }>,
	): Promise<string>;
	close?(): void;
}

export function configShow(paths: IoPaths, output: ConfigOutput): void {
	const { config, warnings } = loadConfig(paths);
	for (const warning of warnings) output.stderr(`io: ${warning}\n`);
	output.stdout(`provider   ${config.provider ?? "—"}\n`);
	output.stdout(`model      ${config.model ?? "—"}\n`);
	output.stdout(`thinking   ${config.thinkingLevel ?? "—"}\n`);
	output.stdout(`verbosity  ${config.verbosity ?? "normal"}\n`);
	output.stdout(`mode       ${resolvePermissionMode(config)}\n`);
	output.stdout(`bell       ${config.bell === false ? "off" : "on"}\n`);
	output.stdout(`skills     ${config.skills === false ? "off" : "on"}\n`);
	output.stdout(`context    ${config.contextFiles === false ? "off" : "on"}\n`);
	const appearance = config.appearance ?? {};
	output.stdout(`theme      ${appearance.theme ?? "io"}\n`);
	output.stdout(`tps        ${appearance.tps === false ? "off" : "on"}\n`);
	output.stdout(`markdown   ${appearance.markdown ?? "rendered"}\n`);
	output.stdout(`toolOutput ${appearance.toolOutput ?? "collapsed"}\n`);
	if (config.scopedModels && config.scopedModels.length > 0) {
		output.stdout(`scope      ${config.scopedModels.join(", ")}\n`);
	}
	for (const rule of config.permissions ?? []) {
		output.stdout(`permission ${rule.effect.padEnd(5)} ${rule.resource}\n`);
	}
	output.stdout(`config     ${paths.configPath}\n`);
	output.stdout(`data       ${paths.dataDir}\n`);
}

export async function configSet(
	paths: IoPaths,
	engine: AgentEngine,
	key: string,
	value: string,
	output: ConfigOutput,
): Promise<void> {
	const current = loadConfig(paths).config;
	const models = await engine.listModels();
	const providers = [...new Set(models.map((model) => model.provider))];
	const next = await updateConfig(current, key, value, providers);
	saveConfig(paths, next);
	output.stdout(`Saved ${paths.configPath}\n`);
	output.stdout(
		`provider ${next.provider ?? "—"} · model ${next.model ?? "—"} · thinking ${next.thinkingLevel ?? "—"} · verbosity ${next.verbosity ?? "normal"} · mode ${resolvePermissionMode(next)}\n`,
	);
}

export async function configEdit(
	paths: IoPaths,
	engine: AgentEngine,
	prompt: ConfigPrompt,
	output: ConfigOutput,
): Promise<void> {
	const current = loadConfig(paths).config;
	const models = await engine.listModels();
	const providers = [...new Set(models.map((model) => model.provider))];
	const provider = await prompt.select(
		"Select provider:",
		providers.map((id) => ({
			id,
			label: id,
			description: `${models.filter((model) => model.provider === id).length} models`,
		})),
	);
	const providerModels = models.filter((model) => model.provider === provider);
	const model = await prompt.select(
		"Select default model:",
		providerModels.map((entry) => ({
			id: entry.id,
			label: entry.name,
			description: `${entry.id} · ${formatTokens(entry.contextWindow)} ctx`,
		})),
	);
	const next: IoConfig = { ...current, provider, model };
	saveConfig(paths, next);
	output.stdout(`Saved ${paths.configPath}\nprovider ${provider} · model ${model}\n`);
}

async function updateConfig(
	config: IoConfig,
	key: string,
	value: string,
	providers: readonly string[],
): Promise<IoConfig> {
	switch (key) {
		case "provider": {
			if (!providers.includes(value)) {
				throw new CliError(`Unknown provider "${value}". Configured providers: ${providers.join(", ")}.`);
			}
			const next: IoConfig = { ...config, provider: value };
			if (config.provider !== value) delete next.model;
			return next;
		}
		case "model": {
			const separator = value.indexOf("/");
			const provider = separator > 0 ? value.slice(0, separator) : undefined;
			const id = separator > 0 ? value.slice(separator + 1) : value;
			if (!id) throw new CliError("model must not be empty");
			if (provider && !providers.includes(provider)) {
				throw new CliError(`Unknown provider "${provider}". Configured providers: ${providers.join(", ")}.`);
			}
			return { ...config, model: id, ...(provider ? { provider } : {}) };
		}
		case "thinking":
		case "thinkingLevel":
			if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
				throw new CliError(`Invalid thinking level "${value}". Use one of: ${THINKING_LEVELS.join(", ")}.`);
			}
			return { ...config, thinkingLevel: value as IoConfig["thinkingLevel"] };
		case "verbosity":
			if (!(VERBOSITY_LEVELS as readonly string[]).includes(value)) {
				throw new CliError(`Invalid verbosity "${value}". Use one of: ${VERBOSITY_LEVELS.join(", ")}.`);
			}
			return { ...config, verbosity: value as IoConfig["verbosity"] };
		case "mode":
		case "permissionMode":
			if (!(PERMISSION_MODES as readonly string[]).includes(value)) {
				throw new CliError(`Invalid permission mode "${value}". Use one of: ${PERMISSION_MODES.join(", ")}.`);
			}
			return { ...config, permissionMode: value as IoConfig["permissionMode"] };
		case "skills":
		case "contextFiles":
		case "bell": {
			const parsed = parseBoolean(value);
			if (parsed === undefined) throw new CliError(`Invalid value "${value}" for ${key}. Use on or off.`);
			if (key === "skills") return { ...config, skills: parsed };
			if (key === "bell") return { ...config, bell: parsed };
			return { ...config, contextFiles: parsed };
		}
		case "theme": {
			const themes: readonly IoThemePreference[] = ["io", "io-light", "system", "dark", "light"];
			if (!themes.includes(value as IoThemePreference)) {
				throw new CliError(`Invalid theme "${value}". Use one of: ${themes.join(", ")}.`);
			}
			return { ...config, appearance: { ...config.appearance, theme: value as IoThemePreference } };
		}
		case "tps": {
			const parsed = parseBoolean(value);
			if (parsed === undefined) throw new CliError(`Invalid value "${value}" for tps. Use on or off.`);
			return { ...config, appearance: { ...config.appearance, tps: parsed } };
		}
		case "markdown": {
			if (value !== "rendered" && value !== "source") {
				throw new CliError(`Invalid markdown mode "${value}". Use rendered or source.`);
			}
			return { ...config, appearance: { ...config.appearance, markdown: value } };
		}
		case "toolOutput": {
			if (value !== "collapsed" && value !== "expanded") {
				throw new CliError(`Invalid tool output "${value}". Use collapsed or expanded.`);
			}
			return { ...config, appearance: { ...config.appearance, toolOutput: value } };
		}
		case "thinkingVisible": {
			const parsed = parseBoolean(value);
			if (parsed === undefined) throw new CliError(`Invalid value "${value}" for thinkingVisible. Use on or off.`);
			const appearance: IoAppearanceConfig = { ...config.appearance, thinking: parsed };
			return { ...config, appearance };
		}
		default:
			throw new CliError(
				`Unknown config key "${key}". Use provider, model, thinking, verbosity, mode, skills, contextFiles, bell, theme, tps, markdown, toolOutput or thinkingVisible.`,
			);
	}
}

function parseBoolean(value: string): boolean | undefined {
	switch (value.trim().toLowerCase()) {
		case "true":
		case "on":
		case "yes":
		case "1":
			return true;
		case "false":
		case "off":
		case "no":
		case "0":
			return false;
		default:
			return undefined;
	}
}
