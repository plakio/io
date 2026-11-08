import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { IoPaths } from "./config.js";
import { createHarness, type ConfirmCommand } from "./session.js";
import { resolveAgentModel, getSubagents, type AgentCatalog } from "./agents.js";

const subagentSchema = Type.Object({
	agent: Type.Union([Type.Literal("general"), Type.Literal("explore")], {
		description: "Subagent type: general (can edit/run) or explore (read-only).",
	}),
	task: Type.String({ description: "The task or question to delegate to the subagent." }),
});

export interface SubagentToolOptions {
	cwd: string;
	paths: IoPaths;
	modelRuntime: ModelRuntime;
	currentModel: Model<Api> | undefined;
	catalog: AgentCatalog;
	confirmCommand?: ConfirmCommand;
}

export function createSubagentTool(options: SubagentToolOptions): ToolDefinition<typeof subagentSchema, string> {
	const { cwd, paths, modelRuntime, currentModel, catalog, confirmCommand } = options;
	const subagents = getSubagents(catalog);
	const names = subagents.map((agent) => agent.id).join(", ");

	return defineTool({
		name: "subagent",
		label: "subagent",
		description: `Delegate a task to a subagent with fresh context. Use when a focused subtask (exploration, editing, research) would be faster or cleaner than doing it inline. Subagents return a summary; the parent keeps the main conversation context. Available: ${names}.`,
		promptSnippet: "Delegate independent work to subagents when helpful",
		promptGuidelines: [
			"Use subagents for focused, multi-step tasks that would clutter the main context.",
			"Subagents start fresh; give them enough context to work independently.",
			"The parent agent sees the subagent's final summary, not its intermediate commands.",
		],
		parameters: subagentSchema,
		async execute(_toolCallId, { agent, task }, signal, onUpdate, _ctx) {
			const startedAt = Date.now();
			const pushProgress = (message: string) => {
				onUpdate?.({
					content: [{ type: "text", text: message }],
					details: message,
				});
			};

			const definition = getSubagents(catalog).find((candidate) => candidate.id === agent);
			if (!definition) {
				return {
					content: [{ type: "text", text: `Unknown subagent "${agent}". Available: ${names}.` }],
					isError: true,
					details: "unknown subagent",
				};
			}

			const model = resolveAgentModel(definition, currentModel, modelRuntime);
			if (!model) {
				return {
					content: [{ type: "text", text: `No model is available for subagent "${agent}".` }],
					isError: true,
					details: "no model",
				};
			}

			const readonly = definition.access === "readonly";
			const session = await createHarness({
				cwd,
				paths,
				modelRuntime,
				model,
				systemPrompt: definition.systemPrompt,
				confirmCommand: readonly ? undefined : confirmCommand,
				continueSession: false,
			});

			try {
				pushProgress(`subagent ${agent} starting`);
				await session.session.prompt(task);
				const text = session.session.getLastAssistantText() ?? "(no summary returned)";
				const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
				pushProgress(`subagent ${agent} completed in ${elapsed}s`);
				return {
					content: [{ type: "text", text }],
					details: `subagent ${agent} completed`,
				};
			} catch (error) {
				const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
				pushProgress(`subagent ${agent} failed in ${elapsed}s`);
				return {
					content: [{ type: "text", text: `Subagent ${agent} failed: ${(error as Error).message}` }],
					isError: true,
					details: `subagent ${agent} error`,
				};
			} finally {
				session.session.dispose();
			}
		},
	});
}
