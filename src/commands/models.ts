import { loadConfig, saveConfig, type IoPaths } from "../config.js";
import { CliError } from "../errors.js";
import { formatTokens } from "../format.js";
import { LinePrompter } from "../term-prompt.js";
import { getSupportedProvider, isSupportedProvider, modelReference } from "../providers.js";
import {
	createIoModelRuntime,
	knownProviderIds,
	loadAvailableModels,
	providerDisplayName,
	refreshCatalogs,
} from "../runtime.js";

export async function runModels(
	paths: IoPaths,
	options: { provider?: string; refresh: boolean },
): Promise<void> {
	const runtime = await createIoModelRuntime(paths);
	if (options.provider && !knownProviderIds(runtime).includes(options.provider)) {
		throw new CliError(
			`Unknown provider "${options.provider}". Configured providers: ${knownProviderIds(runtime).join(", ")}.\nAdd custom providers in ${paths.modelsPath}.`,
		);
	}
	const provider = options.provider;

	if (options.refresh) {
		if (provider && !isSupportedProvider(provider)) {
			process.stdout.write(
				`${providerDisplayName(runtime, provider)} uses a static models.json catalog; nothing to refresh.\n`,
			);
		} else {
			process.stdout.write("Refreshing model catalogs…\n");
			const refreshed = await refreshCatalogs(runtime, provider);
			if (refreshed.aborted) {
				process.stdout.write("Model refresh timed out; using cached catalogs.\n");
			} else if (refreshed.errors.size > 0) {
				const details = [...refreshed.errors.entries()]
					.map(([providerId, error]) => `${providerDisplayName(runtime, providerId)}: ${error.message}`)
					.join("; ");
				process.stdout.write(`Model refresh incomplete (${details}); using cached catalogs.\n`);
			}
		}
	}

	const available = await loadAvailableModels(runtime, provider);
	const config = loadConfig(paths).config;
	const providersToList = provider ? [provider] : available.providers;
	let printedAny = false;
	let modelNumber = 0;
	const allModels = providersToList.flatMap((providerId) =>
		available.models.filter((model) => model.provider === providerId),
	);

	for (const providerId of providersToList) {
		const models = available.models.filter((model) => model.provider === providerId);
		const error = available.errors.get(providerId);
		if (models.length === 0) {
			if (error) {
				process.stdout.write(`${providerDisplayName(runtime, providerId)}: ${error.message}\n`);
			}
			continue;
		}
		printedAny = true;
		process.stdout.write(`\n${providerDisplayName(runtime, providerId)} (${providerId})\n`);
		const idWidth = Math.max(...models.map((model) => model.id.length), 4);
		for (const model of models) {
			modelNumber += 1;
			const preferred =
				config.provider === model.provider && config.model === model.id ? " *" : "  ";
			const context = model.contextWindow ? `${formatTokens(model.contextWindow)} ctx` : "";
			process.stdout.write(
				`  ${String(modelNumber).padStart(3)}. ${model.id.padEnd(idWidth)}${preferred} ${model.name.padEnd(32)} ${context}\n`,
			);
		}
	}

	if (!printedAny) {
		const hint = provider
			? getSupportedProvider(provider)?.loginHint
			: "io auth login opencode-go (or export OPENCODE_API_KEY)";
		const customHint =
			provider && !isSupportedProvider(provider)
				? `\nSet the apiKey or its environment variable in: ${paths.modelsPath}`
				: "";
		throw new CliError(
			`No authenticated models found.${hint ? `\nAuthenticate with: ${hint}` : ""}${customHint}`,
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
