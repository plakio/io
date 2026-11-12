import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import type { Api, AuthInteraction, Model } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import {
	ModelRuntime,
	type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent";
import { ensureIoDirectories, type IoPaths } from "./config.js";
import {
	isSupportedProvider,
	providerIds,
	providerName,
} from "./providers.js";

// The Pi SDK loads OAuth flows through runtime-variable imports so bundlers do
// not pull Node-only callback-server code into browser builds. IO is a Node
// bundle, so register the statically bundled flows before any provider login,
// token refresh, or request reaches them.
registerBunOAuthFlows();

/** Providers explicitly configured in models.json, keyed by runtime instance. */
const configuredProviders = new WeakMap<ModelRuntime, readonly string[]>();

function readModelsJsonProviders(modelsPath: string): Record<string, unknown> | undefined {
	try {
		const raw = JSON.parse(readFileSync(modelsPath, "utf8")) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const providers = (raw as { providers?: unknown }).providers;
		if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
		return providers as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** Provider IDs declared under `providers` in a models.json file. */
export function readConfiguredProviderIds(modelsPath: string): string[] {
	return Object.keys(readModelsJsonProviders(modelsPath) ?? {}).filter((id) => id.length > 0);
}

const ENV_REFERENCE = /(?<!\$)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * Environment variables referenced by models.json credentials or headers.
 * These are provider secrets and must not reach the model's shell.
 */
export function readProviderEnvNames(modelsPath: string): string[] {
	const providers = readModelsJsonProviders(modelsPath);
	if (!providers) return [];
	const names = new Set<string>();
	const collect = (value: unknown) => {
		if (typeof value !== "string") return;
		for (const match of value.matchAll(ENV_REFERENCE)) {
			const name = match[1] ?? match[2];
			if (name) names.add(name);
		}
	};
	for (const provider of Object.values(providers)) {
		if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
		const entry = provider as Record<string, unknown>;
		collect(entry.apiKey);
		if (entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)) {
			for (const header of Object.values(entry.headers as Record<string, unknown>)) collect(header);
		}
	}
	return [...names];
}

export interface AvailableModels {
	models: Model<Api>[];
	errors: Map<string, Error>;
	/** Known providers in display order: io's built-ins first, then models.json providers. */
	providers: string[];
	providerNames: Map<string, string>;
}

export type RuntimeFactory = (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;

export async function createIoModelRuntime(
	paths: IoPaths,
	factory: RuntimeFactory = ModelRuntime.create,
): Promise<ModelRuntime> {
	ensureIoDirectories(paths);
	const runtime = await factory({
		authPath: paths.authPath,
		modelsPath: paths.modelsPath,
		refreshOnCreate: false,
	});
	configuredProviders.set(runtime, readConfiguredProviderIds(paths.modelsPath));
	// Replay the persisted catalog overlay written by earlier refreshes, so
	// models fetched by a previous `io models --refresh` survive across
	// sessions. Offline only: no network here.
	await restoreCatalogs(runtime);
	return runtime;
}

function providerCatalog(runtime: ModelRuntime): { ids: string[]; names: Map<string, string> } {
	const ids: string[] = [];
	const names = new Map<string, string>();
	const getProvider = (id: string) =>
		typeof runtime.getProvider === "function" ? runtime.getProvider(id) : undefined;
	for (const id of providerIds()) {
		ids.push(id);
		names.set(id, getProvider(id)?.name ?? providerName(id));
	}
	for (const id of configuredProviders.get(runtime) ?? []) {
		if (names.has(id)) continue;
		ids.push(id);
		names.set(id, getProvider(id)?.name ?? id);
	}
	return { ids, names };
}

/** Providers io can address: built-ins first, then providers declared in models.json. */
export function knownProviderIds(runtime: ModelRuntime): string[] {
	return providerCatalog(runtime).ids;
}

export function providerDisplayName(runtime: ModelRuntime, providerId: string): string {
	return providerCatalog(runtime).names.get(providerId) ?? providerName(providerId);
}

export function knownProviderOrThrow(runtime: ModelRuntime, providerId: string): string {
	const known = knownProviderIds(runtime);
	if (!known.includes(providerId)) {
		throw new Error(
			`Unknown provider "${providerId}". Configured providers: ${known.join(", ")}. Add custom providers in models.json.`,
		);
	}
	return providerId;
}

export async function loadAvailableModels(
	runtime: ModelRuntime,
	provider?: string,
): Promise<AvailableModels> {
	const errors = new Map<string, Error>();
	const catalog = providerCatalog(runtime);
	const providers: readonly string[] = provider ? [provider] : catalog.ids;
	const results = await Promise.allSettled(
		providers.map(async (providerId) => ({
			providerId,
			models: await runtime.getAvailable(providerId),
		})),
	);

	const allowed = new Set(catalog.ids);
	if (provider) allowed.add(provider);
	const models: Model<Api>[] = [];
	for (let index = 0; index < results.length; index++) {
		const result = results[index];
		if (!result) continue;
		if (result.status === "rejected") {
			const reason = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
			errors.set(providers[index] ?? "unknown", reason);
			continue;
		}
		models.push(...result.value.models.filter((model) => allowed.has(model.provider)));
	}

	const ordered = catalog.ids.flatMap((providerId) => models.filter((model) => model.provider === providerId));
	return { models: ordered, errors, providers: catalog.ids, providerNames: catalog.names };
}

export interface ProviderStatus {
	id: string;
	name: string;
	configured: boolean;
	source?: string;
	authType?: "api_key" | "oauth";
	modelCount: number;
}

export async function getProviderStatuses(runtime: ModelRuntime): Promise<ProviderStatus[]> {
	const available = await loadAvailableModels(runtime);
	const statuses: ProviderStatus[] = [];
	for (const providerId of available.providers) {
		const check = await runtime.checkAuth(providerId).catch(() => undefined);
		statuses.push({
			id: providerId,
			name: available.providerNames.get(providerId) ?? providerName(providerId),
			configured: check !== undefined,
			source: check?.source,
			authType: check?.type,
			modelCount: available.models.filter((model) => model.provider === providerId).length,
		});
	}
	return statuses;
}

export async function loginProvider(
	runtime: ModelRuntime,
	providerId: string,
	interaction: AuthInteraction,
	options: { getDeviceId?: () => string } = {},
): Promise<void> {
	if (!knownProviderIds(runtime).includes(providerId)) {
		throw new Error(
			`Unknown provider "${providerId}". Configured providers: ${knownProviderIds(runtime).join(", ")}.`,
		);
	}
	const provider = runtime.getProvider(providerId);
	if (!provider) {
		throw new Error(`Provider "${providerId}" is not available in this Pi SDK build.`);
	}
	const authType = provider.auth.oauth ? "oauth" : "api_key";
	await runtime.login(providerId, authType, interaction, {
		agentName: "io",
		...options,
	});
	await runtime.refresh({ providers: [providerId] }).catch(() => undefined);
}

export async function logoutProvider(runtime: ModelRuntime, providerId: string): Promise<void> {
	if (!knownProviderIds(runtime).includes(providerId)) {
		throw new Error(
			`Unknown provider "${providerId}". Configured providers: ${knownProviderIds(runtime).join(", ")}.`,
		);
	}
	await runtime.logout(providerId);
}

/** Replay persisted catalog overlays (from earlier refreshes). Never touches the network. */
export async function restoreCatalogs(runtime: ModelRuntime): Promise<void> {
	await runtime.refresh({ allowNetwork: false }).catch(() => undefined);
}

/**
 * Reload models.json and recompose every provider without network access.
 * Used by `/reload` so newly added custom providers appear in-session.
 */
export async function reloadModelsJson(runtime: ModelRuntime, modelsPath: string): Promise<void> {
	await runtime.refresh({ allowNetwork: false }).catch(() => undefined);
	configuredProviders.set(runtime, readConfiguredProviderIds(modelsPath));
}

export async function refreshCatalogs(
	runtime: ModelRuntime,
	provider?: string,
	options: { timeoutMs?: number; force?: boolean } = {},
): Promise<{ aborted: boolean; errors: Map<string, Error> }> {
	// models.json providers are static; there is no catalog endpoint to refresh.
	if (provider && !isSupportedProvider(provider)) {
		return { aborted: false, errors: new Map() };
	}
	const timeoutMs = options.timeoutMs ?? 15_000;
	const force = options.force ?? true;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const result = await runtime.refresh({
			allowNetwork: true,
			providers: provider ? [provider] : providerIds(),
			force,
			signal: controller.signal,
		});
		return { aborted: result.aborted, errors: new Map(result.errors) };
	} catch (error) {
		return {
			aborted: controller.signal.aborted,
			errors: new Map([[provider ?? "catalog", error instanceof Error ? error : new Error(String(error))]]),
		};
	} finally {
		clearTimeout(timeout);
	}
}

export function getOrCreateDeviceId(paths: IoPaths): string {
	ensureIoDirectories(paths);
	try {
		const existing = readFileSync(paths.deviceIdPath, "utf8").trim();
		if (/^[0-9a-f-]{16,}$/i.test(existing)) return existing;
	} catch {
		// Create one below.
	}
	const deviceId = randomUUID();
	writeFileSync(paths.deviceIdPath, `${deviceId}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(paths.deviceIdPath, 0o600);
	return deviceId;
}

export function authStoragePath(paths: IoPaths): string {
	return paths.authPath;
}
