#!/usr/bin/env node

import { parseArgs, HELP_TEXT } from "./args.js";
import { resolvePaths } from "./config.js";
import { CliError } from "./errors.js";
import { APP_NAME, VERSION } from "./version.js";

// Piping into head/grep is normal Unix usage. Exit quietly when the reader
// closes the pipe instead of printing an unhandled EPIPE stack trace.
for (const stream of [process.stdout, process.stderr]) {
	stream.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") process.exit(0);
		throw error;
	});
}

async function run(argv: string[]): Promise<void> {
	const parsed = parseArgs(argv);
	if (parsed.error) {
		process.stderr.write(`io: ${parsed.error}\nRun \`io --help\` for usage.\n`);
		process.exitCode = 2;
		return;
	}

	const command = parsed.command;
	if (!command) {
		process.stderr.write("io: invalid command\n");
		process.exitCode = 2;
		return;
	}
	switch (command.kind) {
		case "help":
			process.stdout.write(HELP_TEXT);
			return;
		case "version":
			process.stdout.write(`${APP_NAME} ${VERSION}\n`);
			return;
		case "config-show": {
			const { runConfigShow } = await import("./commands/config.js");
			runConfigShow(resolvePaths());
			return;
		}
		case "config-interactive": {
			const { runConfigInteractive } = await import("./commands/config.js");
			await runConfigInteractive(resolvePaths());
			return;
		}
		case "config-set": {
			const { runConfigSet } = await import("./commands/config.js");
			runConfigSet(resolvePaths(), command.key, command.value);
			return;
		}
		case "auth-login": {
			const { runAuthLogin } = await import("./commands/auth.js");
			await runAuthLogin(resolvePaths(), command.provider);
			return;
		}
		case "auth-logout": {
			const { runAuthLogout } = await import("./commands/auth.js");
			await runAuthLogout(resolvePaths(), command.provider);
			return;
		}
		case "auth-status": {
			const { runAuthStatus } = await import("./commands/auth.js");
			await runAuthStatus(resolvePaths());
			return;
		}
		case "models": {
			const { runModels } = await import("./commands/models.js");
			await runModels(resolvePaths(), { provider: command.provider, refresh: command.refresh });
			return;
		}
		case "sessions": {
			const { runSessions } = await import("./commands/sessions.js");
			await runSessions(resolvePaths(), process.cwd());
			return;
		}
		case "interactive": {
			if (!process.stdin.isTTY || !process.stdout.isTTY) {
				throw new CliError(
					"interactive mode requires a terminal.\nRun `io --help` for commands that work without one.",
				);
			}
			const { runInteractive } = await import("./main.js");
			const code = await runInteractive({
				continueSession: command.continueSession,
				sessionId: command.sessionId,
				modelRef: command.modelRef,
				provider: command.provider,
			});
			process.exitCode = code;
			return;
		}
	}
}

run(process.argv.slice(2)).catch((error: unknown) => {
	if (error instanceof CliError) {
		if (error.message.length > 0) process.stderr.write(`io: ${error.message}\n`);
		process.exitCode = error.exitCode;
		return;
	}
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`io: ${message}\n`);
	process.exitCode = 1;
});
