import {
	THINKING_LEVELS,
	loadConfig,
	saveConfig,
	type IoConfig,
	type IoPaths,
} from "../config.js";
import { CliError } from "../errors.js";
import { isSupportedProvider, parseModelReference, providerIds } from "../providers.js";

export function runConfigShow(paths: IoPaths): void {
	const { config, warnings } = loadConfig(paths);
	for (const warning of warnings) process.stderr.write(`io: ${warning}\n`);
	process.stdout.write(`provider   ${config.provider ?? "—"}\n`);
	process.stdout.write(`model      ${config.model ?? "—"}\n`);
	process.stdout.write(`thinking   ${config.thinkingLevel ?? "—"}\n`);
	process.stdout.write(`config     ${paths.configPath}\n`);
	process.stdout.write(`data       ${paths.dataDir}\n`);
	process.stdout.write(`credentials ${paths.authPath}\n`);
	process.stdout.write(`sessions   ${paths.sessionsDir}\n`);
}

function updateConfig(config: IoConfig, key: string, value: string): IoConfig {
	switch (key) {
		case "provider": {
			if (!isSupportedProvider(value)) {
				throw new CliError(`Unknown provider "${value}". Supported providers: ${providerIds().join(", ")}.`);
			}
			const next: IoConfig = { ...config, provider: value };
			if (config.provider !== value) delete next.model;
			return next;
		}
		case "model": {
			const parsed = parseModelReference(value);
			if (parsed.provider && !isSupportedProvider(parsed.provider)) {
				throw new CliError(`Unknown provider "${parsed.provider}". Supported providers: ${providerIds().join(", ")}.`);
			}
			if (!parsed.model) throw new CliError("model must not be empty");
			const next: IoConfig = { ...config, model: parsed.model };
			if (parsed.provider) next.provider = parsed.provider;
			return next;
		}
		case "thinking":
		case "thinkingLevel": {
			if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
				throw new CliError(`Invalid thinking level "${value}". Use one of: ${THINKING_LEVELS.join(", ")}.`);
			}
			return { ...config, thinkingLevel: value as IoConfig["thinkingLevel"] };
		}
		default:
			throw new CliError(`Unknown config key "${key}". Use provider, model, or thinking.`);
	}
}

export function runConfigSet(paths: IoPaths, key: string, value: string): void {
	const current = loadConfig(paths).config;
	const next = updateConfig(current, key, value);
	saveConfig(paths, next);
	process.stdout.write(`Saved ${paths.configPath}\n`);
	process.stdout.write(`provider ${next.provider ?? "—"} · model ${next.model ?? "—"} · thinking ${next.thinkingLevel ?? "—"}\n`);
}
