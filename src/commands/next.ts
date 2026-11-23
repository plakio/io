import type { AgentEngine, EngineModel, EngineSessionSummary } from "../engine/types.js";
import { formatTokens } from "../format.js";

export function modelLines(models: readonly EngineModel[]): string[] {
	return models.map((model) => {
		const windows = [
			`ctx ${formatTokens(model.contextWindow)}`,
			model.variants.length > 0 ? `variants ${model.variants.join(",")}` : undefined,
			model.cost ? `$${model.cost.input.toFixed(2)}/$${model.cost.output.toFixed(2)}` : undefined,
		].filter((value): value is string => value !== undefined);
		return `${model.provider}/${model.id}  ${model.name}  ${windows.join("  ")}`;
	});
}

export function sessionLines(sessions: readonly EngineSessionSummary[]): string[] {
	return sessions.map((session) => {
		const updated = new Date(session.updatedAt).toISOString().replace("T", " ").slice(0, 16);
		return `${session.id}  ${updated}  ${session.title}`;
	});
}

export async function listModels(
	engine: AgentEngine,
	provider?: string,
): Promise<readonly EngineModel[]> {
	const models = await engine.listModels();
	if (!provider) return models;
	return models.filter((model) => model.provider === provider);
}

export async function listSessions(engine: AgentEngine): Promise<readonly EngineSessionSummary[]> {
	return engine.listSessions({ limit: 100 });
}
