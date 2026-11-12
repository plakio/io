import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface IoConfig {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	primaryAgent?: string;
	agents?: Record<string, { model?: string }>;
	/** `provider/id` refs that Ctrl+P cycles through. Empty/undefined means all. */
	scopedModels?: string[];
	/** Shell permission rules (action is always `shell`). Last matching rule wins. */
	permissions?: ShellPermissionRule[];
	/** Load AGENTS.md/CLAUDE.md from the cwd and its ancestors. Default true. */
	contextFiles?: boolean;
	/** Load skills from ~/.agents/skills and <cwd>/.agents/skills. Default true. */
	skills?: boolean;
}

/** Context settings with their defaults resolved. */
export function resolveContextSettings(config: IoConfig): { skills: boolean; contextFiles: boolean } {
	return { skills: config.skills !== false, contextFiles: config.contextFiles !== false };
}

export type ShellPermissionEffect = "allow" | "deny" | "ask";

export interface ShellPermissionRule {
	/** Wildcard pattern matched against the whole normalized shell command. `*` spans anything, `?` one char. */
	resource: string;
	effect: ShellPermissionEffect;
}

export interface IoPaths {
	configDir: string;
	dataDir: string;
	configPath: string;
	authPath: string;
	modelsPath: string;
	sessionsDir: string;
	deviceIdPath: string;
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

function absolute(path: string, home: string): string {
	return resolve(expandHome(path, home));
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): IoPaths {
	const configBase = env.IO_CONFIG_DIR
		? absolute(env.IO_CONFIG_DIR, home)
		: join(env.XDG_CONFIG_HOME ? absolute(env.XDG_CONFIG_HOME, home) : join(home, ".config"), "io");
	const dataBase = env.IO_DATA_DIR
		? absolute(env.IO_DATA_DIR, home)
		: join(env.XDG_DATA_HOME ? absolute(env.XDG_DATA_HOME, home) : join(home, ".local", "share"), "io");

	return {
		configDir: configBase,
		dataDir: dataBase,
		configPath: join(configBase, "config.json"),
		authPath: join(dataBase, "auth.json"),
		modelsPath: join(dataBase, "models.json"),
		sessionsDir: join(dataBase, "sessions"),
		deviceIdPath: join(dataBase, "device-id"),
	};
}

export function ensureIoDirectories(paths: IoPaths): void {
	mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
	mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
	mkdirSync(paths.sessionsDir, { recursive: true, mode: 0o700 });
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function parseConfig(raw: unknown): { config: IoConfig; warnings: string[] } {
	const warnings: string[] = [];
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { config: {}, warnings: ["config must be a JSON object; using defaults"] };
	}
	const input = raw as Record<string, unknown>;
	const config: IoConfig = {};
	if (typeof input.provider === "string" && input.provider.length > 0) {
		config.provider = input.provider;
	} else if (input.provider !== undefined) {
		warnings.push("ignoring invalid config value: provider");
	}
	if (typeof input.model === "string" && input.model.length > 0) {
		config.model = input.model;
	} else if (input.model !== undefined) {
		warnings.push("ignoring invalid config value: model");
	}
	if (isThinkingLevel(input.thinkingLevel)) {
		config.thinkingLevel = input.thinkingLevel;
	} else if (input.thinkingLevel !== undefined) {
		warnings.push("ignoring invalid config value: thinkingLevel");
	}
	if (typeof input.primaryAgent === "string" && input.primaryAgent.length > 0) {
		config.primaryAgent = input.primaryAgent;
	} else if (input.primaryAgent !== undefined) {
		warnings.push("ignoring invalid config value: primaryAgent");
	}
	if (Array.isArray(input.scopedModels) && input.scopedModels.every((ref) => typeof ref === "string" && ref.length > 0)) {
		config.scopedModels = input.scopedModels as string[];
	} else if (input.scopedModels !== undefined) {
		warnings.push("ignoring invalid config value: scopedModels");
	}
	if (Array.isArray(input.permissions)) {
		const rules: ShellPermissionRule[] = [];
		let invalid = false;
		for (const rule of input.permissions) {
			if (rule && typeof rule === "object" && "resource" in rule && "effect" in rule) {
				const resource = (rule as { resource?: unknown }).resource;
				const effect = (rule as { effect?: unknown }).effect;
				if (
					typeof resource === "string" &&
					resource.length > 0 &&
					(effect === "allow" || effect === "deny" || effect === "ask")
				) {
					rules.push({ resource, effect });
				} else {
					invalid = true;
				}
			} else {
				invalid = true;
			}
		}
		if (invalid) warnings.push("ignoring invalid entries in permissions");
		if (rules.length > 0) config.permissions = rules;
	}
	if (typeof input.contextFiles === "boolean") {
		config.contextFiles = input.contextFiles;
	} else if (input.contextFiles !== undefined) {
		warnings.push("ignoring invalid config value: contextFiles");
	}
	if (typeof input.skills === "boolean") {
		config.skills = input.skills;
	} else if (input.skills !== undefined) {
		warnings.push("ignoring invalid config value: skills");
	}
	if (input.agents && typeof input.agents === "object" && !Array.isArray(input.agents)) {
		const agents: NonNullable<IoConfig["agents"]> = {};
		for (const [id, value] of Object.entries(input.agents as Record<string, unknown>)) {
			if (value && typeof value === "object" && !Array.isArray(value)) {
				const model = (value as Record<string, unknown>).model;
				if (typeof model === "string" && model.length > 0) {
					agents[id] = { model };
				}
			}
		}
		config.agents = Object.keys(agents).length > 0 ? agents : undefined;
	} else if (input.agents !== undefined) {
		warnings.push("ignoring invalid config value: agents");
	}
	return { config, warnings };
}

export function loadConfig(paths: IoPaths): { config: IoConfig; warnings: string[] } {
	let content: string;
	try {
		content = readFileSync(paths.configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { config: {}, warnings: [] };
		}
		return {
			config: {},
			warnings: [`could not read ${paths.configPath}: ${(error as Error).message}`],
		};
	}

	try {
		return parseConfig(JSON.parse(content) as unknown);
	} catch (error) {
		return {
			config: {},
			warnings: [`could not parse ${paths.configPath}: ${(error as Error).message}`],
		};
	}
}

export function saveConfig(paths: IoPaths, config: IoConfig): void {
	ensureIoDirectories(paths);
	const content = `${JSON.stringify(config, null, 2)}\n`;
	const temporaryPath = `${paths.configPath}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
	renameSync(temporaryPath, paths.configPath);
	chmodSync(paths.configPath, 0o600);
}
