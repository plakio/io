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
	SUPPORTED_PROVIDERS,
	isSupportedProvider,
	parseModelReference,
	providerIds,
	providerName,
} from "../providers.js";
import {
	createIoModelRuntime,
	getProviderStatuses,
	loadAvailableModels,
} from "../runtime.js";

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
		const providerOptions = SUPPORTED_PROVIDERS.map((provider) => {
			const status = statuses.find((entry) => entry.id === provider.id);
			return {
				id: provider.id,
				label: provider.name,
				description: status?.configured
					? `${status.source ?? "configured"} · ${status.modelCount} model${status.modelCount === 1 ? "" : "s"}`
					: "not configured",
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
