import { loadConfig, saveConfig, type IoPaths } from "../config.js";
import { CliError } from "../errors.js";
import { formatTokens } from "../format.js";
import { LinePrompter } from "../term-prompt.js";
import { getSupportedProvider, modelReference, providerIds, providerName } from "../providers.js";
import {
	createIoModelRuntime,
	loadAvailableModels,
	refreshCatalogs,
	supportedProviderOrThrow,
} from "../runtime.js";

export async function runModels(
	paths: IoPaths,
	options: { provider?: string; refresh: boolean },
): Promise<void> {
	if (options.provider && !getSupportedProvider(options.provider)) {
		throw new CliError(
			`Unknown provider "${options.provider}". Supported providers: ${providerIds().join(", ")}.`,
		);
	}
	const provider = options.provider ? supportedProviderOrThrow(options.provider) : undefined;
	const runtime = await createIoModelRuntime(paths);

	if (options.refresh) {
		process.stdout.write("Refreshing model catalogs…\n");
		const refreshed = await refreshCatalogs(runtime, provider);
		if (refreshed.aborted) {
			process.stdout.write("Model refresh timed out; using cached catalogs.\n");
		} else if (refreshed.errors.size > 0) {
			const details = [...refreshed.errors.entries()]
				.map(([providerId, error]) => `${providerName(providerId)}: ${error.message}`)
				.join("; ");
			process.stdout.write(`Model refresh incomplete (${details}); using cached catalogs.\n`);
		}
	}

	const available = await loadAvailableModels(runtime, provider);
	const config = loadConfig(paths).config;
	const providersToList = provider ? [provider] : providerIds();
	let printedAny = false;
	const allModels = providersToList.flatMap((providerId) =>
		available.models.filter((model) => model.provider === providerId),
	);

	for (const providerId of providersToList) {
		const models = available.models.filter((model) => model.provider === providerId);
		const error = available.errors.get(providerId);
		if (models.length === 0) {
			if (error) {
				process.stdout.write(`${providerName(providerId)}: ${error.message}\n`);
			}
			continue;
		}
		printedAny = true;
		process.stdout.write(`\n${providerName(providerId)} (${providerId})\n`);
		const idWidth = Math.max(...models.map((model) => model.id.length), 4);
		for (const model of models) {
			const preferred =
				config.provider === model.provider && config.model === model.id ? " *" : "  ";
			const context = model.contextWindow ? `${formatTokens(model.contextWindow)} ctx` : "";
			process.stdout.write(
				`  ${model.id.padEnd(idWidth)}${preferred} ${model.name.padEnd(32)} ${context}\n`,
			);
		}
	}

	if (!printedAny) {
		const hint = provider
			? getSupportedProvider(provider)?.loginHint
			: "io auth login opencode-go (or export OPENCODE_API_KEY)";
		throw new CliError(
			`No authenticated models found.${hint ? `\nAuthenticate with: ${hint}` : ""}`,
		);
	}
	if (provider === undefined) {
		process.stdout.write("\n* configured default model\n");
	}

	if (process.stdin.isTTY && process.stdout.isTTY && printedAny && allModels.length > 0) {
		const prompter = new LinePrompter();
		try {
			const answer = (await prompter.readLine("\nSet a default model? Enter number (blank to exit): ")).trim();
			const number = Number(answer);
			if (Number.isInteger(number) && number >= 1 && number <= allModels.length) {
				const selected = allModels[number - 1];
				if (selected) {
					const state = loadConfig(paths);
					saveConfig(paths, { ...state.config, provider: selected.provider, model: selected.id });
					process.stdout.write(`Default model: ${modelReference(selected)}\n`);
				}
			}
		} finally {
			prompter.close();
		}
	}
}
