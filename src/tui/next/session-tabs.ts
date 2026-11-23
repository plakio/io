import type { AgentEngine, EngineSessionSummary } from "../../engine/types.js";
import type { IoShell } from "./shell.js";

/** Keeps the shell tab strip in sync with the engine's root sessions. */
export class IoSessionTabs {
	private readonly shell: IoShell;
	private readonly engine: AgentEngine;
	private sessions: readonly EngineSessionSummary[] = [];
	private activeID: string | undefined;

	constructor(shell: IoShell, engine: AgentEngine) {
		this.shell = shell;
		this.engine = engine;
	}

	get current(): readonly EngineSessionSummary[] {
		return this.sessions;
	}

	get active(): string | undefined {
		return this.activeID;
	}

	async refresh(activeID?: string): Promise<readonly EngineSessionSummary[]> {
		this.sessions = await this.engine.listSessions({ limit: 20 });
		if (activeID !== undefined) this.activeID = activeID;
		this.render();
		return this.sessions;
	}

	setSessions(sessions: readonly EngineSessionSummary[], activeID?: string): void {
		this.sessions = sessions;
		if (activeID !== undefined) this.activeID = activeID;
		this.render();
	}

	setActive(sessionID: string): void {
		this.activeID = sessionID;
		this.render();
	}

	private render(): void {
		const visible = this.sessions.slice(0, 10);
		const activeIndex = this.activeID ? visible.findIndex((session) => session.id === this.activeID) : -1;
		this.shell.setTabs(
			visible.map((session, index) => ({
				id: String(index + 1),
				label: shorten(session.title, 22),
				status: "idle",
			})),
			activeIndex >= 0 ? String(activeIndex + 1) : undefined,
		);
	}
}

function shorten(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}
