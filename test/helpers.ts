import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { ensureIoDirectories, resolvePaths, type IoPaths } from "../src/config.js";
import { createHarness, type ConfirmCommand, type Harness } from "../src/session.js";

export interface FauxHarness {
	faux: FauxProviderHandle;
	runtime: ModelRuntime;
	paths: IoPaths;
	harness: Harness;
	cleanup: () => void;
}

/**
 * In-memory terminal for IoApp integration tests. TuiMainScreen only needs the
 * Terminal interface; writes are captured instead of touching process.stdout.
 */
export class FakeTerminal implements Terminal {
	readonly output: string[] = [];
	columns = 100;
	rows = 30;
	readonly kittyProtocolActive = false;
	stopped = false;
	private inputHandler: ((data: string) => void) | undefined;
	private resizeHandler: (() => void) | undefined;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		this.stopped = false;
	}

	stop(): void {
		this.stopped = true;
	}

	restoreOnExit(_before: string, _after: string): void {}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

	write(data: string): void {
		this.output.push(data);
	}

	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(_status: ProgramStatus): void {}

	get text(): string {
		return this.output.join("");
	}

	feedInput(data: string): void {
		this.inputHandler?.(data);
	}

	resizeTo(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.resizeHandler?.();
	}
}

export async function waitFor(
	predicate: () => boolean,
	message = "condition",
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${message}`);
}

export function temporaryPaths(prefix = "io-test-"): { paths: IoPaths; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const paths = resolvePaths({
		IO_CONFIG_DIR: join(root, "config"),
		IO_DATA_DIR: join(root, "data"),
	});
	ensureIoDirectories(paths);
	return {
		paths,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

export async function createFauxHarness(options: {
	cwd?: string;
	confirmCommand?: ConfirmCommand;
	notify?: (message: string) => void;
	continueSession?: boolean;
	sessionManager?: SessionManager;
	paths?: IoPaths;
	tokensPerSecond?: number;
	context?: { skills?: boolean; contextFiles?: boolean };
	permissionMode?: "ask" | "auto";
	readonly?: boolean;
	agentModels?: Record<string, { model?: string }>;
} = {}): Promise<FauxHarness> {
	const temporary = options.paths ? { paths: options.paths, cleanup: () => {} } : temporaryPaths();
	const { paths, cleanup } = temporary;
	const cwd = options.cwd ?? process.cwd();
	const faux = fauxProvider({ tokensPerSecond: options.tokensPerSecond ?? 0 });
	const runtime = await ModelRuntime.create({
		authPath: paths.authPath,
		modelsPath: null,
		refreshOnCreate: false,
	});
	runtime.registerNativeProvider(faux.provider);
	const harness = await createHarness({
		cwd,
		paths,
		modelRuntime: runtime,
		model: faux.getModel(),
		continueSession: options.continueSession,
		sessionManager: options.sessionManager,
		confirmCommand: options.confirmCommand,
		notify: options.notify,
		context: options.context,
		permissionMode: options.permissionMode,
		readonly: options.readonly,
		agentModels: options.agentModels,
	});
	return { faux, runtime, paths, harness, cleanup };
}

export function toolResultText(harness: Harness): string {
	const result = harness.session.messages.find((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") return "";
	return result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

export function textEvents(harness: Harness): { deltas: string[]; unsubscribe: () => void } {
	const deltas: string[] = [];
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			deltas.push(event.assistantMessageEvent.delta);
		}
	});
	return { deltas, unsubscribe };
}

export { fauxAssistantMessage };
