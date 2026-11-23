import type {
	AgentEngine,
	EngineModelRef,
	EnginePermissionRequest,
	EnginePermissionRule,
	EngineSession,
} from "../engine/types.js";
import type { PermissionMode, ShellPermissionRule } from "../config.js";
import { decideShellPermission } from "../safety.js";
import { toEnginePermissionRules } from "../engine/permissions.js";
import { formatTokens } from "../format.js";

export interface HeadlessRunOptions {
	cwd: string;
	prompt?: string;
	continueSession?: boolean;
	sessionID?: string;
	modelRef?: string;
	permissionMode?: PermissionMode;
	permissionRules?: readonly ShellPermissionRule[];
	readStdin?: boolean;
	stats?: boolean;
	failOnToolError?: boolean;
}

export interface HeadlessRunOutput {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

export async function runHeadless(
	engine: AgentEngine,
	options: HeadlessRunOptions,
	output: HeadlessRunOutput = {
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
	},
): Promise<number> {
	const stdinPrompt =
		(options.readStdin ?? !options.prompt?.trim()) && !process.stdin.isTTY ? await readStdinText() : "";
	const prompt = [options.prompt?.trim() ?? "", stdinPrompt.trim() ? `--- input ---\n${stdinPrompt.trimEnd()}` : ""]
		.filter(Boolean)
		.join("\n\n");
	if (!prompt) throw new Error("usage: io run [prompt] (omit the prompt to read stdin)");

	const model = await resolveModel(engine, options.modelRef);
	const session = await resolveSession(engine, options, model);
	const permissionMode = options.permissionMode ?? "ask";
	const permissionRules = options.permissionRules ?? [];
	const permissions: EnginePermissionRule[] = [
		{ action: "shell", resource: "*", effect: "ask" },
		...toEnginePermissionRules(permissionRules),
	];
	await session.setPermissions(permissions);

	let streamed = "";
	let printed = false;
	let toolFailures = 0;
	let completed = false;
	let interrupted = false;
	let errorMessage: string | undefined;
	let pipeClosed = false;
	const startedAt = Date.now();

	const write = (text: string) => {
		if (text.length === 0 || pipeClosed) return;
		try {
			output.stdout(text);
			printed = true;
		} catch {
			pipeClosed = true;
			void session.abort().catch(() => undefined);
		}
	};

	const onSignal = () => {
		interrupted = true;
		void session.abort().catch(() => undefined);
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "text_delta") {
			streamed += event.delta;
			write(event.delta);
			return;
		}
		if (event.type === "tool_finished") {
			if (event.status === "error") toolFailures += 1;
			return;
		}
		if (event.type === "turn_ended") {
			if (event.outcome === "succeeded") {
				completed = true;
			} else if (event.outcome === "failed") {
				errorMessage = event.error ?? "turn failed";
			}
			return;
		}
		if (event.type === "permission_requested") {
			void answerPermission(session, event.request, permissionRules, permissionMode, output.stderr);
			return;
		}
		if (event.type === "error") {
			errorMessage = event.message;
		}
	});

	try {
		await session.prompt(prompt);
	} catch (error) {
		errorMessage = (error as Error).message;
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		unsubscribe();
		if (streamed.length > 0 && !streamed.endsWith("\n")) write("\n");
		if (options.stats) {
			const stats = await session.stats().catch(() => undefined);
			const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
			if (stats) {
				output.stderr(
					`io stats: ${formatTokens(stats.tokens.input)} in · ${formatTokens(stats.tokens.output)} out · ` +
						`${formatTokens(stats.tokens.cacheRead)} cache read · ${seconds}s` +
						`${stats.cost > 0 ? ` · $${stats.cost.toFixed(4)}` : ""}` +
						`${toolFailures > 0 ? ` · ${toolFailures} tool failure${toolFailures === 1 ? "" : "s"}` : ""}\n`,
				);
			}
		}
		await session.dispose().catch(() => undefined);
	}

	if (pipeClosed) return 0;
	if (interrupted) return 130;
	if (errorMessage) {
		output.stderr(`error: ${errorMessage}\n`);
		return 1;
	}
	if (options.failOnToolError && toolFailures > 0) return 1;
	return completed || printed ? 0 : 1;
}

async function resolveModel(engine: AgentEngine, reference?: string): Promise<EngineModelRef | undefined> {
	if (!reference) return undefined;
	const separator = reference.indexOf("/");
	if (separator <= 0 || separator === reference.length - 1) {
		throw new Error(`invalid model reference "${reference}"; use provider/model`);
	}
	const provider = reference.slice(0, separator);
	const id = reference.slice(separator + 1);
	const models = await engine.listModels();
	const match = models.find((model) => model.provider === provider && model.id === id);
	if (!match) throw new Error(`model "${reference}" is not available`);
	return { provider, id };
}

async function resolveSession(
	engine: AgentEngine,
	options: HeadlessRunOptions,
	model: EngineModelRef | undefined,
): Promise<EngineSession> {
	if (!options.sessionID && !options.continueSession) {
		return engine.createSession({ directory: options.cwd, model });
	}
	const sessions = await engine.listSessions({ limit: 100 });
	let session;
	if (options.sessionID) {
		const matches = sessions.filter((entry) => entry.id.startsWith(options.sessionID ?? ""));
		if (matches.length === 0) throw new Error(`no session found with id starting "${options.sessionID}"`);
		if (matches.length > 1) throw new Error(`session id "${options.sessionID}" is ambiguous`);
		session = matches[0];
	} else {
		session = sessions[0];
	}
	if (!session) throw new Error("no session to continue");
	const resumed = await engine.resumeSession(session.id);
	if (model) await resumed.setModel(model);
	return resumed;
}

async function answerPermission(
	session: EngineSession,
	request: EnginePermissionRequest,
	rules: readonly ShellPermissionRule[],
	mode: PermissionMode,
	stderr: (text: string) => void,
): Promise<void> {
	for (const command of request.resources.length > 0 ? request.resources : [""]) {
		const decision = decideShellPermission(rules, command, mode);
		if (decision.decision === "deny") {
			stderr(`io headless: blocked: ${command} (${decision.reason ?? "deny rule"})\n`);
			await session
				.respondPermission(request.requestID, "reject", `Blocked by io permissions: ${decision.reason ?? "deny rule"}`)
				.catch(() => undefined);
			return;
		}
		if (decision.decision === "ask" && mode !== "auto") {
			stderr(`io headless: dangerous command denied: ${command} (${decision.reason ?? "approval required"})\n`);
			await session
				.respondPermission(
					request.requestID,
					"reject",
					`Headless run cannot ask for approval, so "${command}" was not run.`,
				)
				.catch(() => undefined);
			return;
		}
	}
	await session.respondPermission(request.requestID, "once").catch(() => undefined);
}

function readStdinText(): Promise<string> {
	const MAX_STDIN_CHARS = 1_000_000;
	return new Promise((resolve) => {
		const chunks: string[] = [];
		let length = 0;
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk: string) => {
			if (length >= MAX_STDIN_CHARS) return;
			const remaining = MAX_STDIN_CHARS - length;
			const accepted = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
			chunks.push(accepted);
			length += accepted.length;
		});
		process.stdin.on("end", () => resolve(chunks.join("")));
		process.stdin.on("error", () => resolve(""));
	});
}
