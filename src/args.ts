import { APP_NAME, APP_TAGLINE } from "./version.js";

export type Command =
	| {
			kind: "interactive";
			continueSession: boolean;
			sessionId?: string;
			modelRef?: string;
			provider?: string;
	  }
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "auth-login"; provider?: string }
	| { kind: "auth-logout"; provider?: string }
	| { kind: "auth-status" }
	| { kind: "models"; provider?: string; refresh: boolean }
	| { kind: "sessions" }
	| { kind: "config-show" }
	| { kind: "config-set"; key: string; value: string };

export type ParseResult = { command: Command; error?: never } | { command?: never; error: string };

export const HELP_TEXT = `${APP_NAME} ${APP_TAGLINE}

Usage:
  io                          Start an interactive session
  io auth login [provider]    Authenticate with a provider
  io auth logout [provider]   Remove stored credentials
  io auth status              Show authentication status
  io models [provider]        List available models
  io sessions                 List recent sessions for this directory
  io config                   Show configuration
  io config set <key> <value> Set provider, model, or thinking level

Options:
  -c, --continue              Continue the most recent session here
      --session <id>          Open a session by id or id prefix
  -m, --model <ref>           Use provider/model for this run
      --provider <id>         Restrict selection to one provider
  -h, --help                  Show this help
  -v, --version               Show the version

Providers:
  opencode-go                 OpenCode Go (API key or OPENCODE_API_KEY)
  openai-codex                OpenAI Codex (ChatGPT OAuth)

Session commands:
  /help  /model  /models  /diff  /session  /login  /quit

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

export function parseArgs(args: string[]): ParseResult {
	if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
		return { command: { kind: "help" } };
	}
	if (args.includes("--version") || args.includes("-v") || args[0] === "version") {
		return { command: { kind: "version" } };
	}

	const first = args[0];
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
		case "sessions":
			if (args.length > 1) {
				return { error: `unexpected argument: ${args[1] ?? ""}` };
			}
			return { command: { kind: "sessions" } };
		case "config": {
			const subcommand = args[1];
			if (subcommand === undefined || subcommand === "show") {
				return { command: { kind: "config-show" } };
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

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (arg === "--continue" || arg === "-c") {
			continueSession = true;
			continue;
		}
		if (arg === "--session") {
			const result = takeValue(args, index, "--session");
			if (result.error) return { error: result.error };
			sessionId = result.value;
			index++;
			continue;
		}
		if (arg === "--model" || arg === "-m") {
			const result = takeValue(args, index, arg);
			if (result.error) return { error: result.error };
			modelRef = result.value;
			index++;
			continue;
		}
		if (arg === "--provider") {
			const result = takeValue(args, index, "--provider");
			if (result.error) return { error: result.error };
			provider = result.value;
			index++;
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
	return { command };
}
