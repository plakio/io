import type { Api, Model } from "@earendil-works/pi-ai";

export type AgentKind = "primary" | "subagent" | "hidden";
export type AgentAccess = "full" | "readonly";

export interface AgentDefinition {
	id: string;
	name: string;
	kind: AgentKind;
	access: AgentAccess;
	model?: string; // provider/model reference; undefined = current model
	systemPrompt: string;
}

export interface AgentCatalog {
	primary: string; // id of the default primary agent
	agents: AgentDefinition[];
}

function promptPrimary(access: AgentAccess, canDelegate: boolean): string {
	const base = `You are IO's primary agent. You run in the user's terminal and work directly with files and system. You have exactly one tool: bash. Use it for everything: reading and writing files, searching, running git, inspecting systems, installing packages, and running ordinary Unix commands.`;
	const accessText =
		access === "readonly"
			? "\nYou are read-only. Do not modify files, run destructive commands, or install packages. You can read, search, and inspect, but you cannot edit."
			: "";
	const delegate = canDelegate
		? "\nYou can delegate independent work to subagents with the `subagent` tool when a task would be faster, safer, or cleaner with fresh context. Subagents return a summary; you keep the main conversation context."
		: "";
	return `${base}${accessText}${delegate}`;
}

function promptSubagent(kind: "general" | "explore"): string {
	if (kind === "general") {
		return `You are IO's general subagent. You work with fresh context on a focused task and return a clear summary to the parent agent. You have exactly one tool: bash. Use it for everything: reading and writing files, searching, running git, inspecting systems, and running ordinary Unix commands. You cannot launch more subagents.`;
	}
	return `You are IO's explore subagent. You work with fresh context on a read-only task and return findings to the parent agent. You have exactly one tool: bash. Use it for reading, searching, listing, and inspecting files and command output. You cannot launch more subagents, and you must not edit files.`;
}

export const DEFAULT_AGENTS: AgentCatalog = {
	primary: "build",
	agents: [
		{
			id: "build",
			name: "Build",
			kind: "primary",
			access: "full",
			systemPrompt: promptPrimary("full", true),
		},
		{
			id: "general",
			name: "General",
			kind: "subagent",
			access: "full",
			systemPrompt: promptSubagent("general"),
		},
		{
			id: "explore",
			name: "Explore",
			kind: "subagent",
			access: "readonly",
			systemPrompt: promptSubagent("explore"),
		},
	],
};

export function getAgent(catalog: AgentCatalog, id: string): AgentDefinition | undefined {
	return catalog.agents.find((agent) => agent.id === id);
}

export function getPrimaryAgents(catalog: AgentCatalog): AgentDefinition[] {
	return catalog.agents.filter((agent) => agent.kind === "primary");
}

export function getSubagents(catalog: AgentCatalog): AgentDefinition[] {
	return catalog.agents.filter((agent) => agent.kind === "subagent");
}

export function canDelegate(agent: AgentDefinition): boolean {
	return agent.kind === "primary" && agent.access === "full";
}

export function isReadonlyAccess(access: AgentAccess): boolean {
	return access === "readonly";
}

export function resolveAgentModel(
	agent: AgentDefinition,
	current: Model<Api> | undefined,
	runtime: { getModel(provider: string, id: string): Model<Api> | undefined },
	override?: string,
): Model<Api> | undefined {
	const reference = override ?? agent.model;
	if (!reference) return current;
	const slash = reference.indexOf("/");
	if (slash <= 0) return current;
	const provider = reference.slice(0, slash);
	const modelId = reference.slice(slash + 1);
	return runtime.getModel(provider, modelId) ?? current;
}
