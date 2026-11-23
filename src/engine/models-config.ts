import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IoPaths } from "../config.js";

interface PiModel {
	id?: unknown;
	name?: unknown;
	reasoning?: unknown;
	contextWindow?: unknown;
	maxTokens?: unknown;
	thinkingLevelMap?: Record<string, unknown>;
}

interface PiProvider {
	name?: unknown;
	baseUrl?: unknown;
	api?: unknown;
	apiKey?: unknown;
	headers?: unknown;
	models?: unknown;
}

const API_PACKAGES: Record<string, string> = {
	"openai-completions": "@opencode/ai/providers/openai-compatible",
	"openai-responses": "@opencode/ai/providers/openai-compatible/responses",
	"anthropic-messages": "@opencode/ai/providers/anthropic-compatible",
	"google-generative-ai": "@opencode/ai/providers/google",
};

export interface ModelsConfigResult {
	path: string | undefined;
	providers: number;
	warnings: string[];
}

/** Translate io's Pi models.json into the OpenCode provider config shape. */
export function syncModelsConfig(paths: IoPaths): ModelsConfigResult {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(paths.modelsPath, "utf8"));
	} catch {
		return { path: undefined, providers: 0, warnings: [] };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { path: undefined, providers: 0, warnings: ["models.json is not an object; ignoring"] };
	}
	const providers = (raw as { providers?: unknown }).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
		return { path: undefined, providers: 0, warnings: [] };
	}
	const warnings: string[] = [];
	const converted: Record<string, unknown> = {};
	for (const [id, value] of Object.entries(providers as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const provider = value as PiProvider;
		const models = Array.isArray(provider.models) ? provider.models : [];
		if (models.length === 0) continue;
		const api = typeof provider.api === "string" ? provider.api : "openai-completions";
		const pkg = API_PACKAGES[api];
		if (!pkg) {
			warnings.push(`provider ${id}: unsupported api "${api}"; skipped`);
			continue;
		}
		const env = envName(provider.apiKey);
		if (!env && typeof provider.apiKey === "string" && provider.apiKey.length > 0) {
			warnings.push(`provider ${id}: literal apiKey cannot be copied; set it in OpenCode credentials`);
		}
		const modelMap: Record<string, unknown> = {};
		for (const rawModel of models) {
			if (!rawModel || typeof rawModel !== "object") continue;
			const model = rawModel as PiModel;
			if (typeof model.id !== "string" || model.id.length === 0) continue;
			modelMap[model.id] = {
				name: typeof model.name === "string" ? model.name : model.id,
				limit: {
					context: number(model.contextWindow, 128_000),
					output: number(model.maxTokens, 16_384),
				},
				capabilities: {
					tools: true,
					input: ["text", "image"],
					output: ["text"],
					...(model.reasoning === true ? { reasoning: { supported: true } } : {}),
				},
			};
		}
		if (Object.keys(modelMap).length === 0) continue;
		converted[id] = {
			name: typeof provider.name === "string" ? provider.name : id,
			package: pkg,
			...(env ? { env: [env] } : {}),
			...(typeof provider.baseUrl === "string" && provider.baseUrl.length > 0
				? { settings: { baseURL: provider.baseUrl } }
				: {}),
			...(provider.headers && typeof provider.headers === "object" ? { headers: provider.headers } : {}),
			models: modelMap,
		};
	}
	const configPath = join(paths.configDir, "opencode", "opencode.json");
	mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
	let existing: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			existing = parsed as Record<string, unknown>;
		}
	} catch {
		// Start with a fresh file.
	}
	const next = {
		$schema: "https://opencode.ai/config.json",
		...existing,
		providers: converted,
	};
	const temporary = `${configPath}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, configPath);
	chmodSync(configPath, 0o600);
	return { path: configPath, providers: Object.keys(converted).length, warnings };
}

function envName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value);
	return match?.[1] ?? match?.[2];
}

function number(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}
