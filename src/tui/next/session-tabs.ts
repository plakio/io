import type { AgentEngine, EngineSessionSummary } from "../../engine/types.js";
import type { IoShell } from "./shell.js";

/** Keeps the shell tab strip in sync with the engine's root sessions. */
export class IoSessionTabs {
	private readonly shell: IoShell;
	private readonly engine: AgentEngine;
	private sessions: readonly EngineSessionSummary[] = [];
	private activeID: string | undefined;
	private readonly closed = new Set<string>();

	constructor(shell: IoShell, engine: AgentEngine) {
		this.shell = shell;
		this.engine = engine;
	}

	get current(): readonly EngineSessionSummary[] {
		return this.visible();
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
		if (activeID !== undefined) {
			this.activeID = activeID;
			this.closed.delete(activeID);
		}
		const known = new Set(sessions.map((session) => session.id));
		for (const id of this.closed) if (!known.has(id)) this.closed.delete(id);
		this.render();
	}

	setActive(sessionID: string): void {
		this.activeID = sessionID;
		this.closed.delete(sessionID);
		this.render();
	}

	sessionAt(slot: number): EngineSessionSummary | undefined {
		return this.visible()[slot - 1];
	}

	/** Hide a tab locally without deleting the session. Returns the next visible tab. */
	closeSlot(slot: number): EngineSessionSummary | undefined {
		const visible = this.visible();
		const target = visible[slot - 1];
		if (!target) return undefined;
		this.closed.add(target.id);
		const next = this.visible();
		this.render();
		return next[Math.min(slot - 1, next.length - 1)] ?? next[0];
	}

	private visible(): readonly EngineSessionSummary[] {
		return this.sessions.filter((session) => !this.closed.has(session.id));
	}

	private render(): void {
		const visible = this.visible().slice(0, 10);
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
