import { ensureIoDirectories, loadConfig, resolveContextSettings, resolvePaths, saveConfig } from "./config.js";
import { CliError } from "./errors.js";
import { providerName, selectModel } from "./providers.js";
import { createIoModelRuntime, loadAvailableModels } from "./runtime.js";
import { createHarness, type ConfirmCommand } from "./session.js";
import { IoApp } from "./tui/app.js";

export interface InteractiveOptions {
	continueSession: boolean;
	sessionId?: string;
	modelRef?: string;
	provider?: string;
}

export interface HeadlessOptions {
	prompt?: string;
	continueSession: boolean;
	sessionId?: string;
	modelRef?: string;
	provider?: string;
}

/**
 * Run a prompt non-interactively (headless). Pi's `pi --print` / opencode's
 * `opencode run` equivalent: streams the assistant's text to stdout and exits.
 * Dangerous commands are denied (no TUI to confirm) and reported on stderr.
 */
export async function runHeadless(options: HeadlessOptions): Promise<number> {
	const stdinText = process.stdin.isTTY ? "" : await readStdinText();
	const prompt = [
		options.prompt?.trim() ?? "",
		stdinText.trim() ? `--- input ---\n${stdinText.trimEnd()}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
	if (prompt.length === 0) {
		throw new CliError("usage: `io run [prompt...]` (omit the prompt to read stdin)");
	}

	const paths = resolvePaths();
	ensureIoDirectories(paths);
	const loaded = loadConfig(paths);
	let config = loaded.config;
	const contextSettings = resolveContextSettings(config);

	const runtime = await createIoModelRuntime(paths);
	const available = await loadAvailableModels(runtime);
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

	const harness = await createHarness({
		cwd: process.cwd(),
		paths,
		modelRuntime: runtime,
		model: selected,
		thinkingLevel: config.thinkingLevel,
		continueSession: options.continueSession,
		sessionId: options.sessionId,
		confirmCommand: async ({ command, reason }) => {
			process.stderr.write(`io headless: dangerous command denied: ${command} (${reason})\n`);
			return false;
		},
		notify: (message) => process.stderr.write(`io headless: ${message}\n`),
		context: contextSettings,
	});

	if (!options.modelRef && !options.provider) {
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
	let printed = false;
	let streamed = "";
	let streamError: string | undefined;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "assistant") {
			streamed = "";
			return;
		}
		if (event.type === "message_update" && event.message.role === "assistant") {
			if (event.assistantMessageEvent.type === "text_delta") {
				const delta = event.assistantMessageEvent.delta;
				if (delta.length > 0) {
					process.stdout.write(delta);
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
			process.stdout.write(text);
			streamed = text;
			printed = true;
		} else if (text.length > streamed.length && text.startsWith(streamed)) {
			process.stdout.write(text.slice(streamed.length));
			streamed = text;
			printed = true;
		}
		if (streamed.length > 0 && !streamed.endsWith("\n")) process.stdout.write("\n");
		const message = event.message as { stopReason?: string; errorMessage?: string };
		if (message.stopReason === "error") {
			streamError = message.errorMessage ?? "unknown provider error";
			process.stderr.write(`error: ${streamError}\n`);
		}
	});
	try {
		await session.prompt(prompt);
	} finally {
		unsubscribe?.();
	}
	try {
		session.dispose();
	} catch {
		// Terminal restoration is more important than a dispose error.
	}
	if (streamError) return 1;
	return printed ? 0 : 1;
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
	return new Promise((resolvePromise) => {
		const chunks: string[] = [];
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk: string) => chunks.push(chunk));
		process.stdin.on("end", () => resolvePromise(chunks.join("")));
		process.stdin.on("error", () => resolvePromise(""));
	});
}

export async function runInteractive(options: InteractiveOptions): Promise<number> {
	const paths = resolvePaths();
	ensureIoDirectories(paths);
	const loaded = loadConfig(paths);
	const warnings = [...loaded.warnings];
	let config = loaded.config;
	const contextSettings = resolveContextSettings(config);

	const runtime = await createIoModelRuntime(paths);
	const available = await loadAvailableModels(runtime);
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
	const harness = await createHarness({
		cwd: process.cwd(),
		paths,
		modelRuntime: runtime,
		model: selected,
		thinkingLevel: config.thinkingLevel,
		continueSession: options.continueSession,
		sessionId: options.sessionId,
		confirmCommand: async (request) => {
			if (!confirmHandler) return false;
			return confirmHandler(request);
		},
		notify: (message) => notifyHandler?.(message),
		context: contextSettings,
	});

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
		cwd: process.cwd(),
		paths,
		runtime,
		harness,
		model: selected,
		config,
		warnings,
	});
	confirmHandler = app.getConfirmCommand();
	notifyHandler = (message) => app.notify(message);
	return app.run();
}
