import type { Api, Model } from "@earendil-works/pi-ai";

export const SUPPORTED_PROVIDERS = [
	{
		id: "opencode-go",
		name: "OpenCode Go",
		auth: "api_key",
		loginHint: "io auth login opencode-go (or export OPENCODE_API_KEY)",
	},
	{
		id: "openai-codex",
		name: "OpenAI Codex",
		auth: "oauth",
		loginHint: "io auth login openai-codex",
	},
] as const;

export type SupportedProviderId = (typeof SUPPORTED_PROVIDERS)[number]["id"];
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export function getSupportedProvider(providerId: string): SupportedProvider | undefined {
	return SUPPORTED_PROVIDERS.find((provider) => provider.id === providerId);
}

export function isSupportedProvider(providerId: string): providerId is SupportedProviderId {
	return getSupportedProvider(providerId) !== undefined;
}

export function providerName(providerId: string): string {
	return getSupportedProvider(providerId)?.name ?? providerId;
}

export function providerIds(): SupportedProviderId[] {
	return SUPPORTED_PROVIDERS.map((provider) => provider.id);
}

export function modelReference(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function parseModelReference(reference: string): { provider?: string; model: string } {
	const trimmed = reference.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) {
		return { model: trimmed };
	}
	return { provider: trimmed.slice(0, separator), model: trimmed.slice(separator + 1) };
}

export interface ModelPreference {
	provider?: string;
	model?: string;
}

export interface ModelSelection {
	model: Model<Api>;
	warning?: string;
}

export type ModelSelectionResult = { ok: true; selection: ModelSelection } | { ok: false; error: string };

function chooseFirst(models: readonly Model<Api>[]): Model<Api> | undefined {
	const byProviderOrder = providerIds();
	for (const provider of byProviderOrder) {
		const match = models.find((model) => model.provider === provider);
		if (match) return match;
	}
	return models[0];
}

export function selectModel(
	models: readonly Model<Api>[],
	preference: ModelPreference,
	options: { modelRef?: string; provider?: string } = {},
): ModelSelectionResult {
	if (models.length === 0) {
		return {
			ok: false,
			error: "No models are available. Authenticate with `io auth login` and try again.",
		};
	}

	const restricted = options.provider ? models.filter((model) => model.provider === options.provider) : models;
	if (options.provider && restricted.length === 0) {
		const knownProvider = getSupportedProvider(options.provider);
		if (!knownProvider) {
			return {
				ok: false,
				error: `Unknown provider "${options.provider}". Supported providers: ${providerIds().join(", ")}.`,
			};
		}
		return {
			ok: false,
			error: `No models are available for ${knownProvider.name}. Run \`${knownProvider.loginHint}\`.`,
		};
	}

	if (options.modelRef) {
		const parsed = parseModelReference(options.modelRef);
		const match = restricted.find(
			(model) =>
				model.id === parsed.model && (parsed.provider === undefined || model.provider === parsed.provider),
		);
		if (!match) {
			return {
				ok: false,
				error: `Model "${options.modelRef}" is not available. Run \`io models\` to list authenticated models.`,
			};
		}
		if (!isSupportedProvider(match.provider)) {
			return {
				ok: false,
				error: `Provider "${match.provider}" is not supported by this version of io.`,
			};
		}
		return { ok: true, selection: { model: match } };
	}

	const preferredProvider = options.provider ?? preference.provider;
	if (preferredProvider && !isSupportedProvider(preferredProvider)) {
		const fallback = chooseFirst(restricted);
		return {
			ok: true,
			selection: {
				model: fallback as Model<Api>,
				warning: `Configured provider "${preferredProvider}" is not supported. Using ${modelReference(fallback as Model<Api>)}.`,
			},
		};
	}

	if (preferredProvider) {
		const providerModels = restricted.filter((model) => model.provider === preferredProvider);
		if (providerModels.length === 0) {
			const fallback = chooseFirst(restricted);
			return {
				ok: true,
				selection: {
					model: fallback as Model<Api>,
					warning: `No authenticated models for ${providerName(preferredProvider)}. Using ${modelReference(fallback as Model<Api>)}.`,
				},
			};
		}
		if (preference.model) {
			const match = providerModels.find((model) => model.id === preference.model);
			if (match) return { ok: true, selection: { model: match } };
			return {
				ok: true,
				selection: {
					model: providerModels[0] as Model<Api>,
					warning: `Preferred model "${preference.model}" is not available. Using ${modelReference(providerModels[0] as Model<Api>)}.`,
				},
			};
		}
		return { ok: true, selection: { model: providerModels[0] as Model<Api> } };
	}

	if (preference.model) {
		const matches = restricted.filter((model) => model.id === preference.model);
		if (matches.length > 0) {
			return { ok: true, selection: { model: matches[0] as Model<Api> } };
		}
	}

	return { ok: true, selection: { model: chooseFirst(restricted) as Model<Api> } };
}

export function filterSupportedModels(models: readonly Model<Api>[]): Model<Api>[] {
	return models.filter((model) => isSupportedProvider(model.provider));
}
