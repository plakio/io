import { ensureIoDirectories, loadConfig, resolveContextSettings, resolvePaths, saveConfig, type IoPaths, type PermissionMode } from "./config.js";
import { CliError } from "./errors.js";
import { DEFAULT_AGENTS, getAgent, type AgentDefinition } from "./agents.js";
import { formatTokens } from "./format.js";
import { isOutputBroken, setOutputBrokenHandler } from "./io-streams.js";
import { providerName, selectModel } from "./providers.js";
import { createIoModelRuntime, loadAvailableModels, type AvailableModels } from "./runtime.js";
import { createHarness, type ConfirmCommand, type Harness } from "./session.js";
import { IoApp } from "./tui/app.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";

function resolveConfiguredAgent(config: { primaryAgent?: string }): AgentDefinition | undefined {
	if (!config.primaryAgent) return undefined;
	const agent = getAgent(DEFAULT_AGENTS, config.primaryAgent);
	return agent?.kind === "primary" ? agent : undefined;
}

export interface InteractiveOptions {
	continueSession: boolean;
	sessionId?: string;
	modelRef?: string;
	provider?: string;
	permissionMode?: PermissionMode;
}

export interface HeadlessOptions {
	prompt?: string;
	continueSession: boolean;
	sessionId?: string;
	modelRef?: string;
	provider?: string;
	permissionMode?: PermissionMode;
	/** Force stdin reading. Undefined means read only when no prompt is given. */
	readStdin?: boolean;
	/** Persist the selected provider/model as the default. Default true. */
	savePreference?: boolean;
	/** Print token/cost/duration stats to stderr. */
	stats?: boolean;
	/** Exit non-zero when any bash tool call failed. */
	failOnToolError?: boolean;
}

/** Dependency injection for integration tests and embedders. */
export interface HeadlessDependencies {
	paths?: IoPaths;
	cwd?: string;
	runtime?: ModelRuntime;
	models?: AvailableModels;
	harness?: Harness;
	/** Output sinks for tests; default to process stdout/stderr. */
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

/** Dependency injection for interactive integration tests. */
export interface InteractiveDependencies {
	paths?: IoPaths;
	cwd?: string;
	runtime?: ModelRuntime;
	models?: AvailableModels;
	harness?: Harness;
	terminal?: Terminal;
	backgroundRefresh?: boolean;
}

/**
 * Run a prompt non-interactively (headless). Pi's `pi --print` / opencode's
 * `opencode run` equivalent: streams the assistant's text to stdout and exits.
 * Dangerous commands are denied (no TUI to confirm) and reported on stderr.
 */
export async function runHeadless(
	options: HeadlessOptions,
	dependencies: HeadlessDependencies = {},
): Promise<number> {
	const writeStdout =
		dependencies.stdout ??
		((text: string) => {
			if (!isOutputBroken()) process.stdout.write(text);
		});
	const writeStderr =
		dependencies.stderr ??
		((text: string) => {
			if (!isOutputBroken()) process.stderr.write(text);
		});
	const shouldReadStdin = options.readStdin ?? !options.prompt?.trim();
	const stdinText = shouldReadStdin && !process.stdin.isTTY ? await readStdinText() : "";
	const prompt = [
		options.prompt?.trim() ?? "",
		stdinText.trim() ? `--- input ---\n${stdinText.trimEnd()}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
	if (prompt.length === 0) {
		throw new CliError("usage: `io run [prompt...]` (omit the prompt to read stdin)");
	}

	const paths = dependencies.paths ?? resolvePaths();
	ensureIoDirectories(paths);
	const loaded = loadConfig(paths);
	let config = loaded.config;
	const cwd = dependencies.cwd ?? process.cwd();
	if (loaded.error) writeStderr(`io: ${loaded.error}\n`);
	if (config.primaryAgent && !resolveConfiguredAgent(config)) {
		writeStderr(`io: unknown primaryAgent "${config.primaryAgent}"; using ${DEFAULT_AGENTS.primary}.\n`);
	}
	const contextSettings = resolveContextSettings(config);

	const runtime = dependencies.runtime ?? (await createIoModelRuntime(paths));
	const available = dependencies.models ?? (await loadAvailableModels(runtime));
	if (available.models.length === 0) {
		throw new CliError(
			[
				"No authenticated models found.",
				"",
				"Authenticate with one of:",
				"  io auth login opencode-go",
				"  io auth login openai-codex",
				"",
				"OpenCode Go also reads OPENCODE_API_KEY from the environment.",
				`OpenAI-compatible providers are configured in ${paths.modelsPath}.`,
				"Check current status with: io auth status",
			].join("\n"),
		);
	}

	const selection = selectModel(available.models, config, {
		modelRef: options.modelRef,
		provider: options.provider,
		knownProviders: available.providers,
	});
	if (!selection.ok) {
		throw new CliError(selection.error);
	}
	const selected = selection.selection.model;

	const harness =
		dependencies.harness ??
		(await createHarness({
			cwd,
			paths,
			modelRuntime: runtime,
			model: selected,
			thinkingLevel: config.thinkingLevel,
			continueSession: options.continueSession,
			sessionId: options.sessionId,
			permissionMode: options.permissionMode,
			agent: resolveConfiguredAgent(config),
			agentModels: config.agents,
			confirmCommand: async ({ command, reason }) => {
				writeStderr(`io headless: dangerous command denied: ${command} (${reason})\n`);
				return false;
			},
			notify: (message) => writeStderr(`io headless: ${message}\n`),
			context: contextSettings,
		}));

	if (options.savePreference !== false && !options.modelRef && !options.provider) {
		if (config.provider !== selected.provider || config.model !== selected.id) {
			config = { ...config, provider: selected.provider, model: selected.id };
			try {
				saveConfig(paths, config);
			} catch {
				// Preference persistence is best-effort for headless runs.
			}
		}
	}

	const session = harness.session;
	const startedAt = Date.now();
	let printed = false;
	let streamed = "";
	let streamError: string | undefined;
	let toolCalls = 0;
	let toolFailures = 0;
	let interrupted = false;
	let pipeClosed = false;
	const onOutputBroken = () => {
		pipeClosed = true;
		void session.abort().catch(() => undefined);
	};
	setOutputBrokenHandler(onOutputBroken);
	if (isOutputBroken()) onOutputBroken();
	const onSignal = () => {
		interrupted = true;
		void session.abort().catch(() => undefined);
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	process.once("SIGHUP", onSignal);
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_end") {
			toolCalls += 1;
			if (event.isError) toolFailures += 1;
			return;
		}
		if (event.type === "message_start" && event.message.role === "assistant") {
			streamed = "";
			return;
		}
		if (event.type === "message_update" && event.message.role === "assistant") {
			if (event.assistantMessageEvent.type === "text_delta") {
				const delta = event.assistantMessageEvent.delta;
				if (delta.length > 0) {
					writeStdout(delta);
					streamed += delta;
					printed = true;
				}
			}
			return;
		}
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		const text = assistantText(event.message);
		// Providers normally stream text deltas. Fall back to the final message
		// when a provider only returns the complete text.
		if (streamed.length === 0 && text.length > 0) {
			writeStdout(text);
			streamed = text;
			printed = true;
		} else if (text.length > streamed.length && text.startsWith(streamed)) {
			writeStdout(text.slice(streamed.length));
			streamed = text;
			printed = true;
		}
		if (streamed.length > 0 && !streamed.endsWith("\n")) writeStdout("\n");
		const message = event.message as { stopReason?: string; errorMessage?: string };
		if (message.stopReason === "error") {
			streamError = message.errorMessage ?? "unknown provider error";
			writeStderr(`error: ${streamError}\n`);
		}
	});
	try {
		await session.prompt(prompt);
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		process.removeListener("SIGHUP", onSignal);
		setOutputBrokenHandler(undefined);
		unsubscribe?.();
		if (options.stats) {
			const stats = session.getSessionStats();
			const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
			writeStderr(
				`io stats: ${formatTokens(stats.tokens.input)} in · ${formatTokens(stats.tokens.output)} out · ` +
					`${formatTokens(stats.tokens.cacheRead)} cache read · ${seconds}s` +
					`${stats.cost > 0 ? ` · $${stats.cost.toFixed(4)}` : ""}` +
					`${toolCalls > 0 ? ` · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}` : ""}\n`,
			);
		}
		try {
			session.dispose();
		} catch {
			// Terminal restoration is more important than a dispose error.
		}
	}
	if (pipeClosed) return 0;
	if (interrupted) return 130;
	if (streamError) return 1;
	if (options.failOnToolError && toolFailures > 0) return 1;
	return printed || toolCalls > 0 ? 0 : 1;
}

function assistantText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block && typeof block === "object") {
				const typed = block as { type?: unknown; text?: unknown };
				if (typed.type === "text" && typeof typed.text === "string") return typed.text;
			}
			return "";
		})
		.filter((part) => part.length > 0)
		.join("\n");
}

function readStdinText(): Promise<string> {
	const MAX_STDIN_CHARS = 1_000_000;
	return new Promise((resolvePromise) => {
		const chunks: string[] = [];
		let length = 0;
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk: string) => {
			if (length >= MAX_STDIN_CHARS) return;
			const remaining = MAX_STDIN_CHARS - length;
			const accepted = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
			chunks.push(accepted);
			length += accepted.length;
		});
		process.stdin.on("end", () => resolvePromise(chunks.join("")));
		process.stdin.on("error", () => resolvePromise(""));
	});
}

export async function runInteractive(
	options: InteractiveOptions,
	dependencies: InteractiveDependencies = {},
): Promise<number> {
	const paths = dependencies.paths ?? resolvePaths();
	ensureIoDirectories(paths);
	const loaded = loadConfig(paths);
	const warnings = [...loaded.warnings];
	let config = loaded.config;
	if (config.primaryAgent && !resolveConfiguredAgent(config)) {
		warnings.push(`unknown primaryAgent "${config.primaryAgent}"; using ${DEFAULT_AGENTS.primary}`);
	}
	const contextSettings = resolveContextSettings(config);

	const runtime = dependencies.runtime ?? (await createIoModelRuntime(paths));
	const available = dependencies.models ?? (await loadAvailableModels(runtime));
	for (const [providerId, error] of available.errors) {
		warnings.push(`${providerName(providerId)}: ${error.message}`);
	}

	if (available.models.length === 0) {
		throw new CliError(
			[
				"No authenticated models found.",
				"",
				"Authenticate with one of:",
				"  io auth login opencode-go",
				"  io auth login openai-codex",
				"",
				"OpenCode Go also reads OPENCODE_API_KEY from the environment.",
				`OpenAI-compatible providers are configured in ${paths.modelsPath}.`,
				"Check current status with: io auth status",
			].join("\n"),
		);
	}

	const selection = selectModel(available.models, config, {
		modelRef: options.modelRef,
		provider: options.provider,
		knownProviders: available.providers,
	});
	if (!selection.ok) {
		throw new CliError(selection.error);
	}
	if (selection.selection.warning) warnings.push(selection.selection.warning);

	const selected = selection.selection.model;
	let confirmHandler: ConfirmCommand | undefined;
	let notifyHandler: ((message: string) => void) | undefined;
	const harness =
		dependencies.harness ??
		(await createHarness({
			cwd: dependencies.cwd ?? process.cwd(),
			paths,
			modelRuntime: runtime,
			model: selected,
			thinkingLevel: config.thinkingLevel,
			continueSession: options.continueSession,
			sessionId: options.sessionId,
			permissionMode: options.permissionMode,
			agent: resolveConfiguredAgent(config),
			agentModels: config.agents,
			confirmCommand: async (request) => {
				if (!confirmHandler) return false;
				return confirmHandler(request);
			},
			notify: (message) => notifyHandler?.(message),
			context: contextSettings,
		}));

	if (!options.modelRef && !options.provider) {
		if (config.provider !== selected.provider || config.model !== selected.id) {
			config = { ...config, provider: selected.provider, model: selected.id };
			try {
				saveConfig(paths, config);
			} catch (error) {
				warnings.push(`could not save model preference: ${(error as Error).message}`);
			}
		}
	}

	const app = new IoApp({
		cwd: dependencies.cwd ?? process.cwd(),
		paths,
		runtime,
		harness,
		model: selected,
		config,
		warnings,
		terminal: dependencies.terminal,
		backgroundRefresh: dependencies.backgroundRefresh,
	});
	confirmHandler = app.getConfirmCommand();
	notifyHandler = (message) => app.notify(message);
	setOutputBrokenHandler(() => app.shutdown(0));
	const onSigterm = () => app.shutdown(143);
	const onSighup = () => app.shutdown(129);
	process.once("SIGTERM", onSigterm);
	process.once("SIGHUP", onSighup);
	try {
		return await app.run();
	} finally {
		process.removeListener("SIGTERM", onSigterm);
		process.removeListener("SIGHUP", onSighup);
		setOutputBrokenHandler(undefined);
	}
}
