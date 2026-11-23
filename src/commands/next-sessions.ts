import { OpenCode } from "@opencode/sdk";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureIoDirectories, type IoPaths } from "../config.js";
import { oneLine } from "../format.js";

export interface TransferMessage {
	id: string;
	time: { created: number; completed?: number };
	type: "user" | "assistant";
	text?: string;
	agent?: string;
	model?: { providerID: string; id: string };
	content?: Array<{ type: "text"; text: string }>;
	finish?: "stop";
}

export interface PiSessionImport {
	piID: string;
	cwd: string;
	createdAt: number;
	title: string;
	model: { providerID: string; id: string };
	messages: TransferMessage[];
}

export interface SessionImportHost {
	sessions: {
		create(input: { location: { directory: string } }): Promise<{ id: string }>;
		remove(input: { sessionID: string }): Promise<void>;
		list(input: { directory: string; limit?: number }): Promise<{ data: Array<{ metadata?: Record<string, unknown> }> }>;
	};
	experimental: {
		session: {
			import(input: {
				info: Record<string, unknown>;
				messages: TransferMessage[];
				location: { directory: string };
			}): Promise<{ id: string }>;
			export(input: { sessionID: string }): Promise<{ info: Record<string, unknown> }>;
		};
	};
	close(): Promise<void>;
}

export async function createSessionImportHost(paths: IoPaths): Promise<SessionImportHost> {
	ensureIoDirectories(paths);
	const host = await OpenCode.create({
		database: { path: join(paths.dataDir, "opencode.db") },
		config: { directory: join(paths.configDir, "opencode"), project: false, claude: false },
		models: { fetch: false },
	});
	return host as unknown as SessionImportHost;
}

export function parsePiSession(content: string): PiSessionImport | undefined {
	let piID = "";
	let cwd = "";
	let createdAt = Date.now();
	let model: PiSessionImport["model"] = { providerID: "opencode", id: "unknown" };
	const messages: TransferMessage[] = [];
	let counter = 0;
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type === "session") {
			if (typeof record.id === "string") piID = record.id;
			if (typeof record.cwd === "string") cwd = record.cwd;
			if (typeof record.timestamp === "string") createdAt = Date.parse(record.timestamp) || createdAt;
			continue;
		}
		if (record.type === "model_change") {
			if (typeof record.provider === "string" && typeof record.modelId === "string") {
				model = { providerID: record.provider, id: record.modelId };
			}
			continue;
		}
		if (record.type !== "message") continue;
		const message = record.message as Record<string, unknown> | undefined;
		if (!message) continue;
		const role = message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf(message.content);
		if (!text.trim()) continue;
		const created = typeof message.timestamp === "string" ? Date.parse(message.timestamp) || Date.now() : Date.now();
		counter += 1;
		if (role === "user") {
			messages.push({
				id: `msg_pi_${counter}`,
				time: { created },
				type: "user",
				text,
			});
		} else {
			messages.push({
				id: `msg_pi_${counter}`,
				time: { created, completed: created + 1 },
				type: "assistant",
				agent: "build",
				model,
				content: [{ type: "text", text }],
				finish: "stop",
			});
		}
	}
	if (!piID || messages.length === 0) return undefined;
	const firstUser = messages.find((message) => message.type === "user")?.text ?? "imported session";
	return { piID, cwd, createdAt, title: oneLine(firstUser, 60), model, messages };
}

export async function importPiSessions(
	host: SessionImportHost,
	sessionsDir: string,
	cwd: string,
	output: { stdout: (text: string) => void; stderr: (text: string) => void },
): Promise<number> {
	let files: string[] = [];
	try {
		files = readdirSync(sessionsDir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => join(sessionsDir, name))
			.filter((path) => statSync(path).isFile());
	} catch {
		output.stdout(`No Pi sessions found in ${sessionsDir}.\n`);
		return 0;
	}
	const existing = await host.sessions.list({ directory: cwd, limit: 100 });
	const importedIDs = new Set(
		existing.data
			.map((session) => session.metadata?.piSessionId)
			.filter((value): value is string => typeof value === "string"),
	);
	let imported = 0;
	let skipped = 0;
	for (const path of files) {
		let parsed: PiSessionImport | undefined;
		try {
			parsed = parsePiSession(readFileSync(path, "utf8"));
		} catch {
			parsed = undefined;
		}
		if (!parsed) {
			skipped += 1;
			continue;
		}
		if (importedIDs.has(parsed.piID)) {
			skipped += 1;
			continue;
		}
		const temp = await host.sessions.create({ location: { directory: cwd } });
		try {
			const exported = await host.experimental.session.export({ sessionID: temp.id });
			const info = {
				...exported.info,
				id: `ses_pi_${parsed.piID.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)}`,
				title: parsed.title,
				time: { created: parsed.createdAt, updated: parsed.createdAt },
				metadata: { piSessionId: parsed.piID, importedFrom: "pi" },
			};
			const created = await host.experimental.session.import({
				info,
				messages: parsed.messages,
				location: { directory: cwd },
			});
			importedIDs.add(parsed.piID);
			output.stdout(`imported ${parsed.piID} → ${created.id} (${parsed.messages.length} messages)\n`);
			imported += 1;
		} finally {
			await host.sessions.remove({ sessionID: temp.id }).catch(() => undefined);
		}
	}
	output.stdout(`\nImported ${imported} session${imported === 1 ? "" : "s"}; skipped ${skipped}.\n`);
	return 0;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: unknown; text?: unknown };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter((part) => part.length > 0)
		.join("\n");
}


export async function pruneSessions(
	host: { list(input: { directory: string; limit?: number }): Promise<{ data: Array<{ id: string; title: string; updatedAt: number }> }>; deleteSession(id: string): Promise<void> },
	cwd: string,
	olderThanDays: number,
	yes: boolean,
	output: { stdout: (text: string) => void; stderr: (text: string) => void },
): Promise<number> {
	const sessions = await host.list({ directory: cwd, limit: 100 });
	const cutoff = Date.now() - Math.max(0, olderThanDays) * 86_400_000;
	const old = sessions.data.filter((session) => session.updatedAt < cutoff);
	if (old.length === 0) {
		output.stdout(`No sessions older than ${olderThanDays} days.\n`);
		return 0;
	}
	for (const session of old) {
		output.stdout(`${yes ? "deleting" : "would delete"} ${session.id}  ${session.title}\n`);
		if (yes) await host.deleteSession(session.id);
	}
	output.stdout(`\n${yes ? "Deleted" : "Matched"} ${old.length} session${old.length === 1 ? "" : "s"}.\n`);
	return 0;
}
