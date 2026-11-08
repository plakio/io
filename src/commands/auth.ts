import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { loadConfig, saveConfig, type IoPaths } from "../config.js";
import { CliError } from "../errors.js";
import {
	SUPPORTED_PROVIDERS,
	getSupportedProvider,
	isSupportedProvider,
	modelReference,
	providerIds,
	providerName,
} from "../providers.js";
import {
	authStoragePath,
	createIoModelRuntime,
	getOrCreateDeviceId,
	getProviderStatuses,
	loadAvailableModels,
	loginProvider,
	logoutProvider,
	supportedProviderOrThrow,
} from "../runtime.js";
import { LinePrompter, PromptCancelled, type SelectOption } from "../term-prompt.js";

function providerOptions(): SelectOption[] {
	return SUPPORTED_PROVIDERS.map((provider) => ({
		id: provider.id,
		label: provider.name,
		description: `${provider.auth === "oauth" ? "ChatGPT OAuth" : "API key"} · ${provider.id}`,
	}));
}

async function chooseProvider(provider: string | undefined, action: string): Promise<string> {
	if (provider) return supportedProviderOrThrow(provider);
	const prompter = new LinePrompter();
	try {
		return await prompter.select(`Select a provider to ${action}:`, providerOptions());
	} finally {
		prompter.close();
	}
}

function notify(events: AuthEvent[]): void {
	for (const event of events) {
		switch (event.type) {
			case "info": {
				process.stdout.write(`\n${event.message}\n`);
				for (const link of event.links ?? []) {
					process.stdout.write(`  ${link.label ? `${link.label}: ` : ""}${link.url}\n`);
				}
				break;
			}
			case "auth_url": {
				process.stdout.write(`\nOpen this URL to continue:\n  ${event.url}\n`);
				if (event.instructions) process.stdout.write(`${event.instructions}\n`);
				break;
			}
			case "device_code": {
				process.stdout.write(`\nOpen this URL:\n  ${event.verificationUri}\n`);
				process.stdout.write(`Enter code: ${event.userCode}\n`);
				break;
			}
			case "progress": {
				process.stdout.write(`\n${event.message}\n`);
				break;
			}
		}
	}
}

function createInteraction(prompter: LinePrompter, controller: AbortController): AuthInteraction {
	prompter.onInterrupt = () => controller.abort();

	const prompt = async (request: AuthPrompt): Promise<string> => {
		const signal = request.signal ?? controller.signal;
		if (request.type === "select") {
			return prompter.select(
				request.message,
				request.options.map((option) => ({
					id: option.id,
					label: option.label,
					description: option.description,
				})),
				signal,
			);
		}
		if (request.type === "secret") {
			return prompter.readLine(`${request.message}: `, { secret: true, signal });
		}
		if (request.type === "manual_code") {
			return prompter.readLine(`${request.message}: `, { signal });
		}
		return prompter.readLine(`${request.message}: `, { signal });
	};

	return {
		signal: controller.signal,
		prompt,
		notify: (event) => notify([event]),
	};
}

export async function runAuthLogin(paths: IoPaths, providerArg?: string): Promise<void> {
	const providerId = await chooseProvider(providerArg, "authenticate");
	const provider = getSupportedProvider(providerId);
	if (!provider) throw new CliError(`Unknown provider "${providerId}".`);

	const runtime = await createIoModelRuntime(paths);
	const prompter = new LinePrompter();
	const controller = new AbortController();
	const interaction = createInteraction(prompter, controller);

	process.stdout.write(`Authenticating with ${provider.name} (${provider.id})...\n`);
	try {
		await loginProvider(runtime, providerId, interaction, {
			getDeviceId: () => getOrCreateDeviceId(paths),
		});
	} catch (error) {
		if (error instanceof PromptCancelled || (error instanceof Error && /cancelled|canceled/i.test(error.message))) {
			process.stdout.write("\nLogin cancelled.\n");
			throw new CliError("", 130);
		}
		throw new CliError(`Authentication failed: ${(error as Error).message}`);
	} finally {
		prompter.close();
	}

	const available = await loadAvailableModels(runtime, providerId);
	const configState = loadConfig(paths);
	const config = configState.config;
	if (!config.provider || !isSupportedProvider(config.provider)) {
		config.provider = providerId;
		delete config.model;
	}
	if (config.provider === providerId && !config.model) {
		const first = available.models[0];
		if (first) config.model = first.id;
	}
	try {
		saveConfig(paths, config);
	} catch (error) {
		process.stderr.write(`io: could not save model preference: ${(error as Error).message}\n`);
	}

	process.stdout.write(`\nSaved credentials for ${provider.name} in ${authStoragePath(paths)}.\n`);
	if (available.models.length > 0) {
		const current = available.models.find((model) => model.provider === config.provider && model.id === config.model);
		if (current) {
			process.stdout.write(`Preferred model: ${modelReference(current)}\n`);
		}
	} else {
		process.stdout.write("Credentials are configured, but the SDK returned no models for this provider.\n");
	}
	process.stdout.write("Start the harness with `io`.\n");
}

export async function runAuthLogout(paths: IoPaths, providerArg?: string): Promise<void> {
	const runtime = await createIoModelRuntime(paths);
	const statuses = await getProviderStatuses(runtime);
	const configured = statuses.filter((status) => status.configured);
	let providerId = providerArg;
	if (!providerId) {
		if (configured.length === 0) {
			process.stdout.write("No stored credentials to remove.\n");
			return;
		}
		const prompter = new LinePrompter();
		try {
			providerId = await prompter.select(
				"Select a provider to log out:",
				configured.map((status) => ({
					id: status.id,
					label: status.name,
					description: status.source,
				})),
			);
		} finally {
			prompter.close();
		}
	}
	if (!providerId) throw new CliError("No provider selected.");
	providerId = supportedProviderOrThrow(providerId);
	await logoutProvider(runtime, providerId);

	const state = loadConfig(paths);
	if (state.config.provider === providerId) {
		delete state.config.provider;
		delete state.config.model;
		saveConfig(paths, state.config);
	}
	process.stdout.write(`Removed stored credentials for ${providerName(providerId)}.\n`);
}

export async function runAuthStatus(paths: IoPaths): Promise<void> {
	const runtime = await createIoModelRuntime(paths);
	const statuses = await getProviderStatuses(runtime);
	const width = Math.max(...statuses.map((status) => status.name.length), 0);
	for (const status of statuses) {
		const name = status.name.padEnd(width);
		if (!status.configured) {
			process.stdout.write(`${name}  not configured\n`);
			continue;
		}
		const source = status.source ?? "configured";
		const models = `${status.modelCount} model${status.modelCount === 1 ? "" : "s"}`;
		process.stdout.write(`${name}  configured · ${source} · ${models}\n`);
	}
	process.stdout.write(`\nCredentials: ${authStoragePath(paths)}\n`);
	process.stdout.write(`Providers:   ${providerIds().join(", ")}\n`);
}
