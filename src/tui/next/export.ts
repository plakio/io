import type { EngineMessage } from "../../engine/types.js";

export interface SessionExportInput {
	id: string;
	title?: string;
	agent?: string;
	model?: string;
	messages: readonly EngineMessage[];
}

/** Markdown transcript for /export and copy commands. */
export function sessionMarkdown(input: SessionExportInput): string {
	const lines = [`# ${input.title ?? "io session"}`, "", `- Session: ${input.id}`];
	if (input.agent) lines.push(`- Agent: ${input.agent}`);
	if (input.model) lines.push(`- Model: ${input.model}`);
	lines.push("");
	for (const message of input.messages) {
		const label = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : message.role;
		lines.push(`## ${label}`, "", message.text.trim(), "");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}
