import { spawn } from "node:child_process";
import { Plugin } from "@opencode/plugin";
import { sanitizeBashEnvironment, shellPatternFor } from "../safety.js";

export interface IoSecurityPluginOptions {
	/** Working directory for every shell command in this host. */
	cwd: string;
	/** Extra environment variables to redact, e.g. names referenced by models.json. */
	envNames?: readonly string[];
	/** Defaults to $SHELL or /bin/bash. */
	shell?: string;
	maxOutputBytes?: number;
}

export interface ShellRunResult {
	output: string;
	exitCode: number | null;
	cancelled: boolean;
	truncated: boolean;
}

export async function runShellCommand(
	command: string,
	options: Pick<IoSecurityPluginOptions, "cwd" | "envNames" | "shell" | "maxOutputBytes">,
	signal?: AbortSignal,
): Promise<ShellRunResult> {
	const shell = options.shell || process.env.SHELL || "/bin/bash";
	const maxBytes = Math.max(4_096, options.maxOutputBytes ?? 1_000_000);
	let output = "";
	let truncated = false;
	const append = (chunk: string) => {
		if (output.length >= maxBytes) {
			truncated = true;
			return;
		}
		const remaining = maxBytes - output.length;
		if (chunk.length > remaining) {
			output += chunk.slice(0, remaining);
			truncated = true;
			return;
		}
		output += chunk;
	};

	return await new Promise<ShellRunResult>((resolve, reject) => {
		const child = spawn(shell, ["-lc", command], {
			cwd: options.cwd,
			env: sanitizeBashEnvironment(process.env, options.envNames),
			stdio: ["ignore", "pipe", "pipe"],
			signal,
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.once("error", (error) => {
			if ((error as NodeJS.ErrnoException).code === "ABORT_ERR") return;
			reject(error);
		});
		child.once("close", (code) => {
			resolve({
				output,
				exitCode: code,
				cancelled: signal?.aborted === true,
				truncated,
			});
		});
	});
}

/**
 * Replaces OpenCode's built-in `shell` tool with io's sanitized implementation:
 * provider secrets never reach the child environment, and every command goes
 * through OpenCode's permission engine before running.
 */
export function createIoSecurityPlugin(options: IoSecurityPluginOptions) {
	return Plugin.define({
		id: "io.security",
		async setup(ctx) {
			await ctx.tool.transform((editor) => {
				editor.remove("shell");
				editor.add({
					name: "shell",
					description:
						"Run a shell command in the project directory. This is io's only tool: use it for reading, writing, searching, git, scripts and system inspection.",
					input: {
						type: "object",
						properties: {
							command: { type: "string", description: "The shell command to execute." },
						},
						required: ["command"],
						additionalProperties: false,
					},
					options: { codemode: false },
					execute: async (input, context) => {
						const command = (input as { command?: unknown }).command;
						if (typeof command !== "string" || command.trim().length === 0) {
							throw new Error("shell command is required");
						}
						await ctx.permission.assert({
							sessionID: context.sessionID,
							agent: context.agent,
							source: { type: "tool", messageID: context.messageID, id: context.id },
							action: "shell",
							resources: [command],
							save: [shellPatternFor(command)],
						});
						const result = await runShellCommand(command, options, context.signal);
						const suffix =
							result.exitCode !== null && result.exitCode !== 0
								? `\n[exit ${result.exitCode}]`
								: result.cancelled
									? "\n[cancelled]"
									: "";
						const text = `${result.output || "(no output)"}${suffix}`;
						return {
							content: [{ type: "text", text }],
							metadata: {
								exitCode: result.exitCode,
								cancelled: result.cancelled,
								truncated: result.truncated,
							},
						};
					},
				});
			});
		},
	});
}
