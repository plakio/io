import { APP_NAME, APP_TAGLINE } from "./version.js";
import type { PermissionMode } from "./config.js";

export type Command =
	| {
			kind: "interactive";
			continueSession: boolean;
			sessionId?: string;
			modelRef?: string;
			provider?: string;
			permissionMode?: PermissionMode;
	  }
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "auth-login"; provider?: string }
	| { kind: "auth-logout"; provider?: string }
	| { kind: "auth-status" }
	| { kind: "models"; provider?: string; refresh: boolean }
	| { kind: "sessions"; prune?: { olderThanDays: number; yes: boolean } }
	| {
			kind: "run";
			prompt?: string;
			continueSession: boolean;
			sessionId?: string;
			modelRef?: string;
			provider?: string;
			permissionMode?: PermissionMode;
			readStdin?: boolean;
			savePreference?: boolean;
			stats?: boolean;
			failOnToolError?: boolean;
	  }
	| { kind: "config-show" }
	| { kind: "config-interactive" }
	| { kind: "config-set"; key: string; value: string };

export type ParseResult = { command: Command; error?: never } | { command?: never; error: string };

export const HELP_TEXT = `${APP_NAME} ${APP_TAGLINE}

Usage:
  io                          Start an interactive session
  io run [prompt...]          Run a prompt non-interactively
  io auth login [provider]    Authenticate with a provider
  io auth logout [provider]   Remove stored credentials
  io auth status              Show authentication status
  io models [provider]        List available models
  io sessions                 List recent sessions for this directory
  io sessions prune           Delete old session files (dry-run by default)
  io config                   Show or edit configuration interactively
  io config show              Show configuration
  io config edit              Interactive configuration
  io config set <key> <value> Set provider, model, thinking, verbosity, mode, or context options

Options:
  -c, --continue              Continue the most recent session here
      --session <id>          Open a session by id or id prefix
  -m, --model <ref>           Use provider/model for this run
      --provider <id>         Restrict selection to one provider
      --mode <ask|auto>       Override permissionMode for this invocation
  -h, --help                  Show this help
  -v, --version               Show the version

Headless options (io run):
      --stdin                 Read piped stdin even when a prompt is given
      --no-stdin              Do not read piped stdin
      --no-save               Do not persist the selected model
      --stats                 Print token/cost/duration stats to stderr
      --fail-on-tool-error    Exit non-zero when a tool call fails

Providers:
  opencode-go                 OpenCode Go (API key or OPENCODE_API_KEY)
  openai-codex                OpenAI Codex (ChatGPT OAuth)
  amazon-bedrock              Amazon Bedrock (bearer token or AWS credentials)

Session commands:
  /help  /model  /models  /mode  /diff  /session  /new  /resume
  /compact  /fork  /name  /export  /agent  /login  /quit

Keys:
  Enter                       Send prompt
  Shift+Enter or Ctrl+J       Insert newline
  Esc or Ctrl+C               Cancel generation
  Ctrl+C twice                Exit
  Ctrl+O                      Expand or collapse tool output
`;

function takeValue(args: string[], index: number, flag: string): { value?: string; error?: string } {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) {
		return { error: `${flag} requires a value` };
	}
	return { value };
}

function parseMode(value: string | undefined): { mode?: PermissionMode; error?: string } {
	if (value === undefined) return { error: "--mode requires a value" };
	if (value !== "ask" && value !== "auto") {
		return { error: `invalid --mode "${value}"; use ask or auto` };
	}
	return { mode: value };
}

function parseRunArgs(args: string[]): { command?: Extract<Command, { kind: "run" }>; error?: string } {
	let continueSession = false;
	let sessionId: string | undefined;
	let modelRef: string | undefined;
	let provider: string | undefined;
	let permissionMode: PermissionMode | undefined;
	let readStdin: boolean | undefined;
	let savePreference = true;
	let stats = false;
	let failOnToolError = false;
	const promptParts: string[] = [];
	let collectingPrompt = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === undefined) continue;
		// Once the prompt starts, everything belongs to the prompt. This keeps
		// `io run explain --help` and `io run what is -c` from being parsed as
		// io flags.
		if (collectingPrompt) {
			promptParts.push(arg);
			continue;
		}
		if (arg === "--") {
			collectingPrompt = true;
			continue;
		}
		if (arg === "--continue" || arg === "-c") {
			continueSession = true;
			continue;
		}
		if (arg === "--no-stdin") {
			readStdin = false;
			continue;
		}
		if (arg === "--stdin") {
			readStdin = true;
			continue;
		}
		if (arg === "--no-save") {
			savePreference = false;
			continue;
		}
		if (arg === "--stats") {
			stats = true;
			continue;
		}
		if (arg === "--fail-on-tool-error") {
			failOnToolError = true;
			continue;
		}
		if (arg === "--session" || arg === "--model" || arg === "-m" || arg === "--provider" || arg === "--mode" || arg === "--permission-mode") {
			const result = takeValue(args, index, arg);
			if (result.error) return { error: result.error };
			index++;
			if (arg === "--session") sessionId = result.value;
			else if (arg === "--provider") provider = result.value;
			else if (arg === "--mode" || arg === "--permission-mode") {
				const parsedMode = parseMode(result.value);
				if (parsedMode.error) return { error: parsedMode.error };
				permissionMode = parsedMode.mode;
			} else modelRef = result.value;
			continue;
		}
		if (arg.startsWith("-")) {
			return {
				error: `unknown option: ${arg} (io run takes -c, --session, -m, --model, --provider, --mode, --no-stdin, --no-save, --stats, --fail-on-tool-error, and a prompt; use -- before a prompt starting with -)`,
			};
		}
		collectingPrompt = true;
		promptParts.push(arg);
	}

	if (continueSession && sessionId !== undefined) {
		return { error: "--continue and --session cannot be used together" };
	}

	const command: Extract<Command, { kind: "run" }> = { kind: "run", continueSession };
	const prompt = promptParts.join(" ").trim();
	if (prompt.length > 0) command.prompt = prompt;
	if (sessionId !== undefined) command.sessionId = sessionId;
	if (modelRef !== undefined) command.modelRef = modelRef;
	if (provider !== undefined) command.provider = provider;
	if (permissionMode !== undefined) command.permissionMode = permissionMode;
	if (readStdin !== undefined) command.readStdin = readStdin;
	if (!savePreference) command.savePreference = false;
	if (stats) command.stats = true;
	if (failOnToolError) command.failOnToolError = true;
	return { command };
}

export function parseArgs(args: string[]): ParseResult {
	const first = args[0];
	if (first === "--help" || first === "-h" || first === "help") {
		return { command: { kind: "help" } };
	}
	if (first === "--version" || first === "-v" || first === "version") {
		return { command: { kind: "version" } };
	}
	if (first === "run" && args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
		return { command: { kind: "help" } };
	}

	switch (first) {
		case undefined:
			return { command: { kind: "interactive", continueSession: false } };
		case "auth": {
			const subcommand = args[1];
			if (subcommand === undefined || subcommand === "status") {
				return { command: { kind: "auth-status" } };
			}
			if (subcommand === "login" || subcommand === "logout") {
				if (args.length > 3) {
					return { error: `unexpected argument: ${args[3] ?? ""}` };
				}
				const provider = args[2];
				return {
					command: subcommand === "login" ? { kind: "auth-login", provider } : { kind: "auth-logout", provider },
				};
			}
			return { error: `unknown auth command: ${subcommand}` };
		}
		case "models": {
			let provider: string | undefined;
			let refresh = false;
			for (let index = 1; index < args.length; index++) {
				const arg = args[index];
				if (arg === "--refresh") {
					refresh = true;
				} else if (arg?.startsWith("-")) {
					return { error: `unknown option: ${arg}` };
				} else if (provider === undefined) {
					provider = arg;
				} else {
					return { error: `unexpected argument: ${arg}` };
				}
			}
			return { command: { kind: "models", provider, refresh } };
		}
		case "sessions": {
			if (args[1] !== "prune") {
				if (args.length > 1) {
					return { error: `unexpected argument: ${args[1] ?? ""}` };
				}
				return { command: { kind: "sessions" } };
			}
			let olderThanDays = 30;
			let yes = false;
			for (let index = 2; index < args.length; index++) {
				const arg = args[index];
				if (arg === "--yes") {
					yes = true;
					continue;
				}
				if (arg === "--older-than") {
					const result = takeValue(args, index, "--older-than");
					if (result.error) return { error: result.error };
					index++;
					const days = Number(result.value);
					if (!Number.isInteger(days) || days < 1) {
						return { error: "--older-than requires a positive number of days" };
					}
					olderThanDays = days;
					continue;
				}
				return { error: `unknown option: ${arg}` };
			}
			return { command: { kind: "sessions", prune: { olderThanDays, yes } } };
		}
		case "run": {
			const parsed = parseRunArgs(args.slice(1));
			if (parsed.error) return { error: parsed.error };
			const runCommand = parsed.command;
			if (!runCommand) return { error: "invalid io run arguments" };
			return { command: runCommand };
		}
		case "config": {
			const subcommand = args[1];
			if (subcommand === "show") {
				return { command: { kind: "config-show" } };
			}
			if (subcommand === "edit") {
				return { command: { kind: "config-interactive" } };
			}
			if (subcommand === undefined) {
				return { command: { kind: "config-interactive" } };
			}
			if (subcommand === "set") {
				const key = args[2];
				const value = args[3];
				if (!key || value === undefined) {
					return { error: "usage: io config set <key> <value>" };
				}
				if (args.length > 4) {
					return { error: `unexpected argument: ${args[4] ?? ""}` };
				}
				return { command: { kind: "config-set", key, value } };
			}
			return { error: `unknown config command: ${subcommand}` };
		}
	}

	let continueSession = false;
	let sessionId: string | undefined;
	let modelRef: string | undefined;
	let provider: string | undefined;
	let permissionMode: PermissionMode | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (arg === "--continue" || arg === "-c") {
			continueSession = true;
			continue;
		}
		if (arg === "--session" || arg === "--model" || arg === "-m" || arg === "--provider" || arg === "--mode" || arg === "--permission-mode") {
			const result = takeValue(args, index, arg);
			if (result.error) return { error: result.error };
			index++;
			if (arg === "--session") sessionId = result.value;
			else if (arg === "--provider") provider = result.value;
			else if (arg === "--mode" || arg === "--permission-mode") {
				const parsedMode = parseMode(result.value);
				if (parsedMode.error) return { error: parsedMode.error };
				permissionMode = parsedMode.mode;
			} else modelRef = result.value;
			continue;
		}
		if (arg.startsWith("-")) {
			return { error: `unknown option: ${arg}` };
		}
		return { error: `unexpected argument: ${arg}` };
	}

	if (continueSession && sessionId !== undefined) {
		return { error: "--continue and --session cannot be used together" };
	}

	const command: Extract<Command, { kind: "interactive" }> = { kind: "interactive", continueSession };
	if (sessionId !== undefined) command.sessionId = sessionId;
	if (modelRef !== undefined) command.modelRef = modelRef;
	if (provider !== undefined) command.provider = provider;
	if (permissionMode !== undefined) command.permissionMode = permissionMode;
	return { command };
}
