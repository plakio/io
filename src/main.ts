import { ensureIoDirectories, loadConfig, saveConfig, resolvePaths } from "./config.js";
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

export async function runInteractive(options: InteractiveOptions): Promise<number> {
	const paths = resolvePaths();
	ensureIoDirectories(paths);
	const loaded = loadConfig(paths);
	const warnings = [...loaded.warnings];
	let config = loaded.config;

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
				"Check current status with: io auth status",
			].join("\n"),
		);
	}

	const selection = selectModel(available.models, config, {
		modelRef: options.modelRef,
		provider: options.provider,
	});
	if (!selection.ok) {
		throw new CliError(selection.error);
	}
	if (selection.selection.warning) warnings.push(selection.selection.warning);

	const selected = selection.selection.model;
	let confirmHandler: ConfirmCommand | undefined;
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
	return app.run();
}
