import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, type IoPaths } from "../config.js";
import { CliError } from "../errors.js";
import { getSupportedProvider, isSupportedProvider, modelReference } from "../providers.js";
import {
	authStoragePath,
	createIoModelRuntime,
	getOrCreateDeviceId,
	getProviderStatuses,
	knownProviderIds,
	knownProviderOrThrow,
	loadAvailableModels,
	loginProvider,
	logoutProvider,
	providerDisplayName,
	type ProviderStatus,
} from "../runtime.js";
import { LinePrompter, PromptCancelled, type SelectOption } from "../term-prompt.js";

function providerOptions(statuses: readonly ProviderStatus[]): SelectOption[] {
	return statuses.map((status) => {
		const builtIn = getSupportedProvider(status.id);
		const auth = builtIn
			? builtIn.auth === "oauth"
				? "ChatGPT OAuth"
				: "API key"
			: "models.json";
		const state = status.configured
			? `${status.source ?? "configured"} · ${status.modelCount} model${status.modelCount === 1 ? "" : "s"}`
			: "not configured";
		return { id: status.id, label: status.name, description: `${auth} · ${state}` };
	});
}

async function chooseProvider(
	runtime: ModelRuntime,
	provider: string | undefined,
	action: string,
	statuses: readonly ProviderStatus[],
): Promise<string> {
	if (provider) return knownProviderOrThrow(runtime, provider);
	const prompter = new LinePrompter();
	try {
		return await prompter.select(`Select a provider to ${action}:`, providerOptions(statuses));
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
	const runtime = await createIoModelRuntime(paths);
	const statuses = await getProviderStatuses(runtime);
	const providerId = await chooseProvider(runtime, providerArg, "authenticate", statuses);
	const builtIn = getSupportedProvider(providerId);
	const name = statuses.find((status) => status.id === providerId)?.name ?? providerDisplayName(runtime, providerId);

	const prompter = new LinePrompter();
	const controller = new AbortController();
	const interaction = createInteraction(prompter, controller);

	process.stdout.write(`Authenticating with ${name} (${providerId})...\n`);
	if (providerId === "amazon-bedrock") {
		process.stdout.write(
			"Bedrock uses a bearer token or AWS credentials. For Kimi K3 (Global) enter your bearer token.\n",
		);
	}
	if (!builtIn) {
		process.stdout.write(
			`${name} is defined in models.json. The API key is stored in io's credential file and takes precedence over the key configured there.\n`,
		);
	}
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
	if (!config.provider || !knownProviderIds(runtime).includes(config.provider)) {
		config.provider = providerId;
		delete config.model;
	}
	if (config.provider === providerId && !config.model) {
		let preferred = available.models[0];
		if (providerId === "amazon-bedrock") {
			const kimi = available.models.find((model) => model.id === "global.moonshotai.kimi-k3");
			if (kimi) preferred = kimi;
		}
		if (preferred) config.model = preferred.id;
	}
	try {
		saveConfig(paths, config);
	} catch (error) {
		process.stderr.write(`io: could not save model preference: ${(error as Error).message}\n`);
	}

	process.stdout.write(`\nSaved credentials for ${name} in ${authStoragePath(paths)}.\n`);
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
	providerId = knownProviderOrThrow(runtime, providerId);
	await logoutProvider(runtime, providerId);

	const state = loadConfig(paths);
	if (state.config.provider === providerId) {
		delete state.config.provider;
		delete state.config.model;
		saveConfig(paths, state.config);
	}
	process.stdout.write(`Removed stored credentials for ${providerDisplayName(runtime, providerId)}.\n`);
	if (getSupportedProvider(providerId)) {
		process.stdout.write(
			`If this provider is also authenticated through an environment variable, unset it in your shell.\n`,
		);
	}
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
	process.stdout.write(`Providers:   ${statuses.map((status) => status.id).join(", ")}\n`);
	if (statuses.some((status) => !isSupportedProvider(status.id))) {
		process.stdout.write(`models.json: ${paths.modelsPath}\n`);
	}
}
