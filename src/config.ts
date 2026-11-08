import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface IoConfig {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface IoPaths {
	configDir: string;
	dataDir: string;
	configPath: string;
	authPath: string;
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
