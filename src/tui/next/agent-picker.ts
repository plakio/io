import {
	BoxRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { EngineAgent } from "../../engine/types.js";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoAgentPickerOptions {
	renderer: CliRenderer;
	shell: IoShell;
	agents: readonly EngineAgent[];
	current?: string;
	theme?: IoTheme;
	onSelect: (agent: EngineAgent) => void | Promise<void>;
	onClose?: () => void;
	onError?: (error: unknown) => void;
}

/** OpenCode-style agent picker: primary agents only, hidden maintenance agents excluded. */
export class IoAgentPicker {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly theme: IoTheme;
	private readonly onSelect: IoAgentPickerOptions["onSelect"];
	private readonly onClose: (() => void) | undefined;
	private readonly onError: ((error: unknown) => void) | undefined;
	private agents: readonly EngineAgent[];
	private current: string | undefined;
	private panel: BoxRenderable | undefined;
	private list: ScrollBoxRenderable | undefined;
	private visible: readonly EngineAgent[] = [];
	private selected = 0;
	private opened = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoAgentPickerOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.theme = options.theme ?? ioDarkTheme;
		this.agents = options.agents;
		this.current = options.current;
		this.onSelect = options.onSelect;
		this.onClose = options.onClose;
		this.onError = options.onError;
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get selectedAgent(): EngineAgent | undefined {
		return this.visible[this.selected];
	}

	open(): void {
		if (this.opened) return;
		this.opened = true;
		this.visible = selectableAgents(this.agents);
		this.selected = Math.max(0, this.visible.findIndex((agent) => agent.id === this.current));
		this.panel = this.buildPanel();
		this.shell.showOverlay(this.panel);
		this.renderer.keyInput.on("keypress", this.keyHandler);
		this.refresh();
		this.renderer.requestRender();
	}

	close(): void {
		if (!this.opened) return;
		this.opened = false;
		this.renderer.keyInput.off("keypress", this.keyHandler);
		this.list = undefined;
		this.panel = undefined;
		this.shell.hideOverlay();
		this.onClose?.();
		this.renderer.requestRender();
	}

	setAgents(agents: readonly EngineAgent[]): void {
		this.agents = agents;
		this.visible = selectableAgents(agents);
		this.selected = Math.min(this.selected, Math.max(0, this.visible.length - 1));
		this.refresh();
	}

	setCurrent(agentID: string | undefined): void {
		this.current = agentID;
		this.refresh();
	}

	move(delta: number): void {
		if (this.visible.length === 0) return;
		this.selected = (this.selected + delta + this.visible.length) % this.visible.length;
		this.refresh();
	}

	selectCurrent(): boolean {
		const agent = this.selectedAgent;
		if (!agent) return false;
		this.close();
		void Promise.resolve(this.onSelect(agent)).catch((error) => this.onError?.(error));
		return true;
	}

	dispose(): void {
		this.close();
	}

	private handleKey(event: IoKeyEvent): void {
		if (!this.opened || event.defaultPrevented) return;
		const name = event.name.toLowerCase();
		if (name === "escape") this.close();
		else if (name === "up") this.move(-1);
		else if (name === "down") this.move(1);
		else if (name === "return") this.selectCurrent();
		else return;
		event.preventDefault?.();
		event.stopPropagation?.();
	}

	private buildPanel(): BoxRenderable {
		const panel = new BoxRenderable(this.renderer, {
			width: "72%",
			maxWidth: 90,
			height: "50%",
			maxHeight: 18,
			border: true,
			borderColor: this.theme.border,
			title: "Agents",
			titleColor: this.theme.accent,
			backgroundColor: this.theme.panel,
			padding: 1,
			flexDirection: "column",
			gap: 1,
		});
		const list = new ScrollBoxRenderable(this.renderer, {
			flexGrow: 1,
			flexShrink: 1,
			scrollY: true,
			backgroundColor: this.theme.panel,
			paddingX: 1,
		});
		const hint = new TextRenderable(this.renderer, {
			content: "↑↓ move · enter select · esc close",
			fg: this.theme.muted,
			bg: this.theme.panel,
			height: 1,
			wrapMode: "none",
			truncate: true,
		});
		panel.add(list);
		panel.add(hint);
		this.list = list;
		return panel;
	}

	private refresh(): void {
		if (!this.list) return;
		clearChildren(this.list);
		if (this.visible.length === 0) {
			this.list.add(
				new TextRenderable(this.renderer, {
					content: "No primary agents",
					fg: this.theme.muted,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
				}),
			);
		}
		for (const [index, agent] of this.visible.entries()) {
			const selected = index === this.selected;
			const current = agent.id === this.current ? "●" : " ";
			const description = agent.description ? `  ${agent.description}` : "";
			this.list.add(
				new TextRenderable(this.renderer, {
					content: `${selected ? "›" : " "} ${current} ${agent.name}${description}`,
					fg: selected ? this.theme.accent : this.theme.text,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
					truncate: true,
				}),
			);
		}
		this.renderer.requestRender();
	}
}

/** Agents that can be selected as the session's primary agent. */
export function selectableAgents(agents: readonly EngineAgent[]): readonly EngineAgent[] {
	return agents.filter((agent) => !agent.hidden && agent.mode !== "subagent");
}

function clearChildren(container: { getChildren(): readonly { destroyRecursively(): void }[]; remove(child: never): void }): void {
	for (const child of [...container.getChildren()]) {
		container.remove(child as never);
		child.destroyRecursively();
	}
}
