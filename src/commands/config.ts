import {
	THINKING_LEVELS,
	loadConfig,
	saveConfig,
	type IoConfig,
	type IoPaths,
} from "../config.js";
import { CliError } from "../errors.js";
import { formatTokens } from "../format.js";
import { LinePrompter } from "../term-prompt.js";
import {
	getSupportedProvider,
	parseModelReference,
	providerIds,
} from "../providers.js";
import {
	createIoModelRuntime,
	getProviderStatuses,
	loadAvailableModels,
	readConfiguredProviderIds,
} from "../runtime.js";

export function runConfigShow(paths: IoPaths): void {
	const { config, warnings } = loadConfig(paths);
	for (const warning of warnings) process.stderr.write(`io: ${warning}\n`);
	process.stdout.write(`provider   ${config.provider ?? "—"}\n`);
	process.stdout.write(`model      ${config.model ?? "—"}\n`);
	process.stdout.write(`thinking   ${config.thinkingLevel ?? "—"}\n`);
	process.stdout.write(`skills     ${config.skills === false ? "off" : "on"}\n`);
	process.stdout.write(`context    ${config.contextFiles === false ? "off" : "on"}\n`);
	process.stdout.write(`config     ${paths.configPath}\n`);
	process.stdout.write(`data       ${paths.dataDir}\n`);
	process.stdout.write(`credentials ${paths.authPath}\n`);
	process.stdout.write(`sessions   ${paths.sessionsDir}\n`);
}

function updateConfig(
	config: IoConfig,
	key: string,
	value: string,
	knownProviders: readonly string[],
): IoConfig {
	switch (key) {
		case "provider": {
			if (!knownProviders.includes(value)) {
				throw new CliError(
					`Unknown provider "${value}". Configured providers: ${knownProviders.join(", ")}. Add custom providers in models.json.`,
				);
			}
			const next: IoConfig = { ...config, provider: value };
			if (config.provider !== value) delete next.model;
			return next;
		}
		case "model": {
			const parsed = parseModelReference(value);
			if (parsed.provider && !knownProviders.includes(parsed.provider)) {
				throw new CliError(
					`Unknown provider "${parsed.provider}". Configured providers: ${knownProviders.join(", ")}. Add custom providers in models.json.`,
				);
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
		case "skills":
		case "contextFiles": {
			const parsed = parseBoolean(value);
			if (parsed === undefined) {
				throw new CliError(`Invalid value "${value}" for ${key}. Use on or off.`);
			}
			return key === "skills" ? { ...config, skills: parsed } : { ...config, contextFiles: parsed };
		}
		default:
			throw new CliError(`Unknown config key "${key}". Use provider, model, thinking, skills, or contextFiles.`);
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

export function runConfigSet(paths: IoPaths, key: string, value: string): void {
	const current = loadConfig(paths).config;
	const knownProviders: string[] = [...providerIds()];
	for (const id of readConfiguredProviderIds(paths.modelsPath)) {
		if (!knownProviders.includes(id)) knownProviders.push(id);
	}
	const next = updateConfig(current, key, value, knownProviders);
	saveConfig(paths, next);
	process.stdout.write(`Saved ${paths.configPath}\n`);
	process.stdout.write(`provider ${next.provider ?? "—"} · model ${next.model ?? "—"} · thinking ${next.thinkingLevel ?? "—"} · skills ${next.skills === false ? "off" : "on"} · context ${next.contextFiles === false ? "off" : "on"}\n`);
}

export async function runConfigInteractive(paths: IoPaths): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		runConfigShow(paths);
		return;
	}
	const runtime = await createIoModelRuntime(paths);
	const prompter = new LinePrompter();
	try {
		const current = loadConfig(paths).config;
		process.stdout.write("Current configuration\n");
		process.stdout.write(`  provider: ${current.provider ?? "—"}\n`);
		process.stdout.write(`  model:    ${current.model ?? "—"}\n`);
		process.stdout.write(`  thinking: ${current.thinkingLevel ?? "—"}\n\n`);

		const statuses = await getProviderStatuses(runtime);
		const providerOptions = statuses.map((status) => {
			const builtIn = getSupportedProvider(status.id);
			const description = status.configured
				? `${status.source ?? "configured"} · ${status.modelCount} model${status.modelCount === 1 ? "" : "s"}`
				: builtIn
					? "not configured"
					: "models.json · not configured";
			return {
				id: status.id,
				label: status.name,
				description,
			};
		});
		const provider = await prompter.select("Select provider:", providerOptions);

		const available = await loadAvailableModels(runtime, provider);
		let model: string | undefined = current.provider === provider ? current.model : undefined;
		if (available.models.length > 0) {
			const modelOptions = available.models.map((entry) => ({
				id: entry.id,
				label: entry.id,
				description: `${entry.name} · ${formatTokens(entry.contextWindow)} ctx`,
			}));
			model = await prompter.select("Select default model:", modelOptions);
		} else {
			process.stdout.write("No authenticated models for this provider; keeping the previous model.\n");
		}

		const thinkingOptions = THINKING_LEVELS.map((level) => ({ id: level, label: level }));
		const thinkingLevel = await prompter.select("Thinking level:", thinkingOptions);

		const next: IoConfig = {
			...current,
			provider,
			thinkingLevel: thinkingLevel as IoConfig["thinkingLevel"],
		};
		if (model) next.model = model;
		else delete next.model;
		saveConfig(paths, next);
		process.stdout.write(
			`\nSaved ${paths.configPath}\nprovider ${next.provider ?? "—"} · model ${next.model ?? "—"} · thinking ${next.thinkingLevel ?? "—"}\n`,
		);
	} catch (error) {
		if (error instanceof Error && /cancelled|canceled/i.test(error.message)) {
			process.stdout.write("\nConfiguration cancelled.\n");
			return;
		}
		throw error;
	} finally {
		prompter.close();
	}
}
