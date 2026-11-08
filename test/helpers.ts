import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureIoDirectories, resolvePaths, type IoPaths } from "../src/config.js";
import { createHarness, type ConfirmCommand, type Harness } from "../src/session.js";

export interface FauxHarness {
	faux: FauxProviderHandle;
	runtime: ModelRuntime;
	paths: IoPaths;
	harness: Harness;
	cleanup: () => void;
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
	continueSession?: boolean;
	sessionManager?: SessionManager;
	paths?: IoPaths;
	tokensPerSecond?: number;
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
