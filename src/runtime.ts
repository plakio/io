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
	filterSupportedModels,
	getSupportedProvider,
	isSupportedProvider,
	providerIds,
	providerName,
	type SupportedProviderId,
} from "./providers.js";

// The Pi SDK loads OAuth flows through runtime-variable imports so bundlers do
// not pull Node-only callback-server code into browser builds. IO is a Node
// bundle, so register the statically bundled flows before any provider login,
// token refresh, or request reaches them.
registerBunOAuthFlows();

export interface AvailableModels {
	models: Model<Api>[];
	errors: Map<string, Error>;
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
	// Replay the persisted catalog overlay written by earlier refreshes, so
	// models fetched by a previous `io models --refresh` survive across
	// sessions. Offline only: no network here.
	await restoreCatalogs(runtime);
	return runtime;
}

export async function loadAvailableModels(
	runtime: ModelRuntime,
	provider?: string,
): Promise<AvailableModels> {
	const errors = new Map<string, Error>();
	const providers: readonly string[] = provider ? [provider] : providerIds();
	const results = await Promise.allSettled(
		providers.map(async (providerId) => ({
			providerId,
			models: await runtime.getAvailable(providerId),
		})),
	);

	const models: Model<Api>[] = [];
	for (let index = 0; index < results.length; index++) {
		const result = results[index];
		if (!result) continue;
		if (result.status === "rejected") {
			const reason = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
			errors.set(providers[index] ?? "unknown", reason);
			continue;
		}
		models.push(...filterSupportedModels(result.value.models));
	}

	const ordered = providerIds().flatMap((providerId) => models.filter((model) => model.provider === providerId));
	return { models: ordered, errors };
}

export interface ProviderStatus {
	id: SupportedProviderId;
	name: string;
	configured: boolean;
	source?: string;
	authType?: "api_key" | "oauth";
	modelCount: number;
}

export async function getProviderStatuses(runtime: ModelRuntime): Promise<ProviderStatus[]> {
	const available = await loadAvailableModels(runtime);
	const statuses: ProviderStatus[] = [];
	for (const provider of providerIds()) {
		const check = await runtime.checkAuth(provider).catch(() => undefined);
		statuses.push({
			id: provider,
			name: providerName(provider),
			configured: check !== undefined,
			source: check?.source,
			authType: check?.type,
			modelCount: available.models.filter((model) => model.provider === provider).length,
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
	if (!isSupportedProvider(providerId)) {
		throw new Error(
			`Unknown provider "${providerId}". Supported providers: ${providerIds().join(", ")}.`,
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
	if (!isSupportedProvider(providerId)) {
		throw new Error(
			`Unknown provider "${providerId}". Supported providers: ${providerIds().join(", ")}.`,
		);
	}
	await runtime.logout(providerId);
}

/** Replay persisted catalog overlays (from earlier refreshes). Never touches the network. */
export async function restoreCatalogs(runtime: ModelRuntime): Promise<void> {
	await runtime.refresh({ allowNetwork: false }).catch(() => undefined);
}

export async function refreshCatalogs(
	runtime: ModelRuntime,
	provider?: string,
	options: { timeoutMs?: number; force?: boolean } = {},
): Promise<{ aborted: boolean; errors: Map<string, Error> }> {
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

export function supportedProviderOrThrow(providerId: string): SupportedProviderId {
	const provider = getSupportedProvider(providerId);
	if (!provider) {
		throw new Error(
			`Unknown provider "${providerId}". Supported providers: ${providerIds().join(", ")}.`,
		);
	}
	return provider.id;
}
