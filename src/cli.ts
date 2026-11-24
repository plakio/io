#!/usr/bin/env node
import { createCliRenderer } from "@opentui/core";
import { loadConfig, resolvePaths } from "./config.js";
import type { IoNextApp } from "./tui/next/app.js";
import { resolveIoTheme } from "./tui/next/theme.js";
import { VERSION } from "./version.js";

const HELP = `io ${VERSION} — OpenCode engine + OpenTUI

Usage:
  io [--session <id>] [--model <provider/model>]
  io run [options] [prompt]
  io models [provider] [--json]
  io sessions [--json]
  io sessions import [--from <dir>]
  io sessions prune [--older-than <days>] [--yes]
  io update
  io auth status
  io auth login [provider]
  io auth logout [provider]
  io auth import
  io config [show|edit]
  io config set <key> <value>

Options:
  --session <id>    Resume a session by id
  --model <ref>     Override the model (provider/model)
  --json            Print models or sessions as JSON
  --help            Show this help
  --version         Print the version

Run options:
  --continue        Continue the latest session
  --session <id>    Continue a specific session
  -m, --model <ref> Override the model
  --mode <mode>     ask or auto
  --stats           Print token/cost stats to stderr
  --fail-on-tool-error  Exit non-zero when a tool fails
  --no-stdin        Never wait for stdin

Remote:
  --server <url>    Attach to an OpenCode server instead of embedded
  --server-token <token>  Bearer token for the remote server
  IO_SERVER_URL / IO_SERVER_TOKEN also work

Runtime:
  Bun 1.3.14+ or Node.js 26.4+ with --experimental-ffi.
`;

function flag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	return args[index + 1];
}

interface RunArguments {
	prompt?: string;
	continueSession: boolean;
	sessionID?: string;
	modelRef?: string;
	mode?: "ask" | "auto";
	stats: boolean;
	failOnToolError: boolean;
	noStdin: boolean;
}

function parseRunArguments(args: readonly string[]): RunArguments {
	const result: RunArguments = {
		continueSession: false,
		stats: false,
		failOnToolError: false,
		noStdin: false,
	};
	const prompt: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") {
			prompt.push(...args.slice(index + 1));
			break;
		}
		if (arg === "--continue") result.continueSession = true;
		else if (arg === "--stats") result.stats = true;
		else if (arg === "--fail-on-tool-error") result.failOnToolError = true;
		else if (arg === "--no-stdin") result.noStdin = true;
		else if (arg === "--session") result.sessionID = args[++index];
		else if (arg === "--model" || arg === "-m") result.modelRef = args[++index];
		else if (arg === "--mode") {
			const mode = args[++index];
			if (mode !== "ask" && mode !== "auto") throw new Error("--mode expects ask or auto");
			result.mode = mode;
		} else if (arg?.startsWith("-")) {
			throw new Error(`unknown run option ${arg}`);
		} else if (arg) {
			prompt.push(arg);
		}
	}
	if (prompt.length > 0) result.prompt = prompt.join(" ");
	return result;
}

async function runHeadlessCommand(args: readonly string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const paths = resolvePaths();
	const loaded = loadConfig(paths);
	for (const warning of loaded.warnings) process.stderr.write(`io: ${warning}\n`);
	if (loaded.error) return 1;
	const parsed = parseRunArguments(args);
	let engine: Awaited<ReturnType<typeof import("./tui/next/app.js").createIoEngine>> | undefined;
	try {
		const { createIoEngine } = await import("./tui/next/app.js");
		const { runHeadless } = await import("./commands/run.js");
		engine = await createIoEngine({ cwd: process.cwd(), paths });
		return await runHeadless(engine, {
			cwd: process.cwd(),
			prompt: parsed.prompt,
			continueSession: parsed.continueSession,
			sessionID: parsed.sessionID,
			modelRef: parsed.modelRef,
			permissionMode: parsed.mode ?? loaded.config.permissionMode,
			permissionRules: loaded.config.permissions,
			readStdin: parsed.noStdin ? false : undefined,
			stats: parsed.stats,
			failOnToolError: parsed.failOnToolError,
		});
	} catch (error) {
		process.stderr.write(`io: ${(error as Error).message}\n`);
		return 1;
	} finally {
		await engine?.close();
	}
}

async function runConfigCommand(args: readonly string[]): Promise<number> {
	const paths = resolvePaths();
	const { configShow, configSet, configEdit } = await import("./commands/next-config.js");
	const output = {
		stdout: (text: string) => process.stdout.write(text),
		stderr: (text: string) => process.stderr.write(text),
	};
	const subcommand = args[0];
	try {
		if (!subcommand || subcommand === "show") {
			configShow(paths, output);
			return 0;
		}
		if (subcommand === "set") {
			const key = args[1];
			const value = args[2];
			if (!key || value === undefined) {
				process.stderr.write("io: usage: io config set <key> <value>\n");
				return 1;
			}
			const { createIoEngine } = await import("./tui/next/app.js");
			const engine = await createIoEngine({ cwd: process.cwd(), paths });
			try {
				await configSet(paths, engine, key, value, output);
				return 0;
			} finally {
				await engine.close();
			}
		}
		if (subcommand === "edit") {
			const { createIoEngine } = await import("./tui/next/app.js");
			const { LinePrompter, PromptCancelled } = await import("./term-prompt.js");
			const prompt = new LinePrompter();
			const engine = await createIoEngine({ cwd: process.cwd(), paths });
			try {
				await configEdit(paths, engine, prompt, output);
				return 0;
			} catch (error) {
				if (error instanceof PromptCancelled) return 130;
				throw error;
			} finally {
				prompt.close();
				await engine.close();
			}
		}
		process.stderr.write(`io: unknown config command "${subcommand}"\n`);
		return 1;
	} catch (error) {
		process.stderr.write(`io: ${(error as Error).message}\n`);
		return 1;
	}
}

async function runAuthCommand(args: readonly string[]): Promise<number> {
	const command = args[0];
	if (!command || command === "--help" || command === "-h") {
		process.stdout.write("usage: io auth <status|login|logout> [provider]\n");
		return command ? 0 : 1;
	}
	const paths = resolvePaths();
	const { createAuthHost, authStatus, authLogin, authLogout, authImport } = await import("./commands/next-auth.js");
	const { LinePrompter, PromptCancelled } = await import("./term-prompt.js");
	const prompt = new LinePrompter();
	const output = {
		stdout: (text: string) => process.stdout.write(text),
		stderr: (text: string) => process.stderr.write(text),
	};
	let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
	try {
		host = await createAuthHost(paths);
		if (command === "status") return await authStatus(host, process.cwd(), output);
		if (command === "login") {
			return await authLogin(host, process.cwd(), { provider: args[1] }, prompt, output);
		}
		if (command === "logout") {
			return await authLogout(host, { provider: args[1] }, output, prompt);
		}
		if (command === "import") {
			return await authImport(host, paths.authPath, process.cwd(), output);
		}
		process.stderr.write(`io: unknown auth command "${command}"\n`);
		return 1;
	} catch (error) {
		if (error instanceof PromptCancelled) return 130;
		process.stderr.write(`io: ${(error as Error).message}\n`);
		return 1;
	} finally {
		prompt.close();
		await host?.close();
	}
}

async function runListCommand(command: "models" | "sessions", args: readonly string[]): Promise<number> {
	const paths = resolvePaths();
	try {
		if (command === "sessions" && args[0] === "import") {
			const from = flag(args, "--from") ?? paths.sessionsDir;
			const { createSessionImportHost, importPiSessions } = await import("./commands/next-sessions.js");
			const host = await createSessionImportHost(paths);
			try {
				return await importPiSessions(host, from, process.cwd(), {
					stdout: (text: string) => process.stdout.write(text),
					stderr: (text: string) => process.stderr.write(text),
				});
			} finally {
				await host.close();
			}
		}
		const { createIoEngine } = await import("./tui/next/app.js");
		const { listModels, listSessions, modelLines, sessionLines } = await import("./commands/next.js");
		const engine = await createIoEngine({ cwd: process.cwd(), paths });
		try {
			if (command === "sessions" && args[0] === "prune") {
				const days = Number(flag(args, "--older-than") ?? "30");
				const { pruneSessions } = await import("./commands/next-sessions.js");
				return await pruneSessions(
					{
						list: async (input) => ({
							data: [...(await engine.listSessions({ directory: input.directory, limit: input.limit }))],
						}),
						deleteSession: (id) => engine.deleteSession(id),
					},
					process.cwd(),
					Number.isFinite(days) ? days : 30,
					args.includes("--yes"),
					{
						stdout: (text: string) => process.stdout.write(text),
						stderr: (text: string) => process.stderr.write(text),
					},
				);
			}
			const json = args.includes("--json");
			if (command === "models") {
				const provider = args.find((arg) => !arg.startsWith("-"));
				const models = await listModels(engine, provider);
				process.stdout.write(json ? `${JSON.stringify(models, null, 2)}\n` : `${modelLines(models).join("\n")}\n`);
			} else {
				const sessions = await listSessions(engine);
				process.stdout.write(json ? `${JSON.stringify(sessions, null, 2)}\n` : `${sessionLines(sessions).join("\n")}\n`);
			}
			return 0;
		} finally {
			await engine.close();
		}
	} catch (error) {
		process.stderr.write(`io: ${(error as Error).message}\n`);
		return 1;
	}
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--server") {
			const url = args[index + 1];
			if (!url) {
				process.stderr.write("io: --server expects a URL\n");
				return 1;
			}
			process.env.IO_SERVER_URL = url;
			args.splice(index, 2);
			index -= 1;
		} else if (args[index] === "--server-token") {
			const token = args[index + 1];
			if (!token) {
				process.stderr.write("io: --server-token expects a value\n");
				return 1;
			}
			process.env.IO_SERVER_TOKEN = token;
			args.splice(index, 2);
			index -= 1;
		}
	}
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	if (args.includes("--version") || args.includes("-v")) {
		process.stdout.write(`io ${VERSION}\n`);
		return 0;
	}

	if (args[0] === "run") {
		return await runHeadlessCommand(args.slice(1));
	}
	if (args[0] === "auth") {
		return await runAuthCommand(args.slice(1));
	}
	if (args[0] === "config") {
		return await runConfigCommand(args.slice(1));
	}
	if (args[0] === "update") {
		const { updateCommand } = await import("./commands/next-update.js");
		return await updateCommand({
			stdout: (text: string) => process.stdout.write(text),
			stderr: (text: string) => process.stderr.write(text),
		});
	}
	if (args[0] === "models" || args[0] === "sessions") {
		return await runListCommand(args[0], args.slice(1));
	}

	const paths = resolvePaths();
	const loaded = loadConfig(paths);
	if (loaded.warnings.length > 0) {
		for (const warning of loaded.warnings) process.stderr.write(`io: ${warning}\n`);
	}
	if (loaded.error) return 1;

	const appearance = loaded.config.appearance;
	const theme = resolveIoTheme(appearance?.theme).theme;
	const renderer = await createCliRenderer({
		exitOnCtrlC: false,
		backgroundColor: theme.background,
	});
	const modelRef = flag(args, "--model");
	const model = modelRef
		? {
				provider: modelRef.slice(0, Math.max(0, modelRef.indexOf("/"))),
				id: modelRef.slice(modelRef.indexOf("/") + 1),
			}
		: undefined;
	if (model && (!model.provider || !model.id)) {
		process.stderr.write("io: --model expects provider/model\n");
		await renderer.destroy();
		return 1;
	}

	let app: IoNextApp | undefined;
	const shutdown = (code: number) => {
		void app?.shutdown(code);
	};
	process.once("SIGTERM", () => shutdown(143));
	process.once("SIGHUP", () => shutdown(129));
	process.once("SIGINT", () => shutdown(130));

	try {
		const { createIoNextApp } = await import("./tui/next/app.js");
		app = await createIoNextApp({
			cwd: process.cwd(),
			paths,
			renderer,
			appearance,
			sessionID: flag(args, "--session"),
			model,
		});
		return await app.run();
	} catch (error) {
		process.stderr.write(`io: ${(error as Error).message}\n`);
		return 1;
	} finally {
		await renderer.destroy();
	}
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		process.stderr.write(`io: ${error?.stack ?? error}\n`);
		process.exitCode = 1;
	});
