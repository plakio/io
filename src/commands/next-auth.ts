import { OpenCode } from "@opencode/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureIoDirectories, type IoPaths } from "../config.js";

export interface AuthCredential {
	id: string;
	integrationID: string;
	label: string;
	active: boolean;
	value: { type: string };
}

export interface AuthProvider {
	id: string;
	name: string;
	integrationID?: string;
}

export interface AuthIntegration {
	id: string;
	name: string;
	methods: Array<{ id?: string; type: string; label?: string; names?: string[] }>;
	connections: Array<{ type: string; label?: string; name?: string }>;
}

export interface AuthHost {
	integration: {
		list(input?: { location?: { directory?: string } }): Promise<{ data: AuthIntegration[] }>;
		oauth?: {
			connect(input: {
				integrationID: string;
				methodID: string;
				location?: { directory?: string };
			}): Promise<{ data: { attemptID: string; url: string; instructions: string; mode: string; paste?: boolean } }>;
			status(input: {
				integrationID: string;
				attemptID: string;
				location?: { directory?: string };
			}): Promise<{ data: { status: string; message?: string } }>;
			complete(input: {
				integrationID: string;
				attemptID: string;
				code?: string;
				location?: { directory?: string };
			}): Promise<void>;
		};
	};
	provider: {
		list(input: { location: { directory: string } }): Promise<{ data: AuthProvider[] }>;
	};
	credential: {
		list(): Promise<AuthCredential[]>;
		create(input: {
			integrationID: string;
			label?: string;
			value: { type: "key"; key: string };
			activate?: boolean;
		}): Promise<AuthCredential>;
		remove(input: { credentialID: string }): Promise<void>;
		activate(input: { credentialID: string }): Promise<void>;
	};
	close(): Promise<void>;
}

export interface AuthOutput {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

export interface AuthPrompt {
	readLine(message: string, options?: { secret?: boolean }): Promise<string>;
	select(message: string, options: Array<{ id: string; label: string; description?: string }>): Promise<string>;
	close?(): void;
}

export async function createAuthHost(paths: IoPaths): Promise<AuthHost> {
	ensureIoDirectories(paths);
	const host = await OpenCode.create({
		database: { path: join(paths.dataDir, "opencode.db") },
		config: { directory: join(paths.configDir, "opencode"), project: false, claude: false },
		models: { fetch: false },
	});
	return {
		integration: host.integration as never,
		provider: host.provider as never,
		credential: host.credential as never,
		close: () => host.close(),
	};
}

export async function authStatus(host: AuthHost, cwd: string, output: AuthOutput): Promise<number> {
	const [providers, credentials] = await Promise.all([
		host.provider.list({ location: { directory: cwd } }),
		host.credential.list(),
	]);
	const names = new Map(providers.data.map((provider) => [provider.integrationID ?? provider.id, provider.name]));
	if (credentials.length === 0) {
		output.stdout("No stored credentials.\n");
		return 0;
	}
	for (const credential of credentials) {
		const name = names.get(credential.integrationID) ?? credential.integrationID;
		output.stdout(
			`${name.padEnd(24)} ${credential.integrationID.padEnd(18)} ${credential.label.padEnd(14)} ${credential.value.type}${credential.active ? " · active" : ""}\n`,
		);
	}
	return 0;
}

export async function authLogin(
	host: AuthHost,
	cwd: string,
	args: { provider?: string; key?: string },
	prompt: AuthPrompt,
	output: AuthOutput,
): Promise<number> {
	const [providers, credentials, integrations] = await Promise.all([
		host.provider.list({ location: { directory: cwd } }),
		host.credential.list(),
		host.integration.list({ location: { directory: cwd } }),
	]);
	let provider = args.provider;
	if (!provider) {
		const options = providers.data.map((entry) => ({
			id: entry.integrationID ?? entry.id,
			label: entry.name,
			description: credentials.some((credential) => credential.integrationID === (entry.integrationID ?? entry.id))
				? "configured"
				: "not configured",
		}));
		if (options.length === 0) {
			output.stderr("No providers available.\n");
			return 1;
		}
		provider = await prompt.select("Select a provider:", options);
	}
	const integration = integrations.data.find((entry) => entry.id === provider);
	const oauth = integration?.methods.find((method) => method.type === "oauth");
	if (oauth && host.integration.oauth) {
		const attempt = await host.integration.oauth.connect({
			integrationID: provider,
			methodID: oauth.id ?? "oauth",
			location: { directory: cwd },
		});
		output.stdout(`\nOpen this URL to continue:\n  ${attempt.data.url}\n`);
		if (attempt.data.instructions) output.stdout(`${attempt.data.instructions}\n`);
		let code: string | undefined;
		if (attempt.data.mode === "code" || attempt.data.paste) {
			code = await prompt.readLine("Authorization code: ");
		}
		if (code) {
			await host.integration.oauth.complete({
				integrationID: provider,
				attemptID: attempt.data.attemptID,
				code,
				location: { directory: cwd },
			});
		} else {
			for (let index = 0; index < 300; index++) {
				const status = await host.integration.oauth.status({
					integrationID: provider,
					attemptID: attempt.data.attemptID,
					location: { directory: cwd },
				});
				if (status.data.status === "complete") break;
				if (status.data.status === "failed" || status.data.status === "expired") {
					output.stderr(`Authentication failed: ${status.data.message ?? status.data.status}\n`);
					return 1;
				}
				await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
		}
		output.stdout(`Authenticated with ${provider}.\n`);
		return 0;
	}
	if (integration?.methods.some((method) => method.type === "env")) {
		const env = integration.methods.find((method) => method.type === "env");
		output.stderr(`Set ${env?.names?.join(" or ") ?? "the provider environment variable"} and retry.\n`);
		return 1;
	}
	const key = args.key ?? (await prompt.readLine("API key: ", { secret: true }));
	if (!key.trim()) {
		output.stderr("Empty API key.\n");
		return 1;
	}
	const credential = await host.credential.create({
		integrationID: provider,
		label: "API key",
		value: { type: "key", key: key.trim() },
		activate: true,
	});
	output.stdout(`Stored ${credential.label} for ${provider}.\n`);
	return 0;
}

export async function authImport(
	host: AuthHost,
	authPath: string,
	cwd: string,
	output: AuthOutput,
): Promise<number> {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(authPath, "utf8"));
	} catch {
		output.stdout("No Pi credentials to import.\n");
		return 0;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		output.stderr("Invalid Pi auth file.\n");
		return 1;
	}
	const [providers, existing] = await Promise.all([
		host.provider.list({ location: { directory: cwd } }),
		host.credential.list(),
	]);
	const known = new Set(providers.data.map((provider) => provider.integrationID ?? provider.id));
	let imported = 0;
	let skipped = 0;
	for (const [piID, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		const entry = value as { type?: unknown; key?: unknown };
		const integrationID = mapPiProvider(piID);
		if (!known.has(integrationID)) {
			output.stderr(`skipped ${piID}: provider ${integrationID} is not configured in OpenCode.\n`);
			skipped += 1;
			continue;
		}
		if (typeof entry.key !== "string" || entry.key.length === 0) {
			output.stderr(`skipped ${piID}: OAuth credentials need an OpenCode login.\n`);
			skipped += 1;
			continue;
		}
		if (existing.some((credential) => credential.integrationID === integrationID && credential.value.type === "key")) {
			output.stdout(`kept ${piID}: an API key already exists in OpenCode.\n`);
			skipped += 1;
			continue;
		}
		const hasActive = existing.some((credential) => credential.integrationID === integrationID && credential.active);
		const credential = await host.credential.create({
			integrationID,
			label: `Imported from io (${piID})`,
			value: { type: "key", key: entry.key },
			activate: !hasActive,
		});
		existing.push(credential);
		output.stdout(`imported ${piID} → ${integrationID}\n`);
		imported += 1;
	}
	output.stdout(`\nImported ${imported} credential${imported === 1 ? "" : "s"}; skipped ${skipped}.\n`);
	return 0;
}

function mapPiProvider(id: string): string {
	if (id === "openai-codex") return "openai";
	return id;
}

export async function authLogout(
	host: AuthHost,
	args: { provider?: string },
	output: AuthOutput,
	prompt?: AuthPrompt,
): Promise<number> {
	const credentials = await host.credential.list();
	let provider = args.provider;
	if (!provider && credentials.length > 1 && prompt) {
		provider = await prompt.select(
			"Select a provider to log out:",
			[...new Set(credentials.map((credential) => credential.integrationID))].map((id) => ({ id, label: id })),
		);
	}
	const matches = provider
		? credentials.filter((credential) => credential.integrationID === provider)
		: credentials;
	if (matches.length === 0) {
		output.stdout("No stored credentials to remove.\n");
		return 0;
	}
	for (const credential of matches) {
		await host.credential.remove({ credentialID: credential.id });
	}
	output.stdout(`Removed ${matches.length} credential${matches.length === 1 ? "" : "s"}\n`);
	return 0;
}
