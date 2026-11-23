import {
	BoxRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { EngineSessionSummary } from "../../engine/types.js";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoSubagentPickerOptions {
	renderer: CliRenderer;
	shell: IoShell;
	sessions: readonly EngineSessionSummary[];
	activeID?: string;
	theme?: IoTheme;
	onSelect: (session: EngineSessionSummary) => void | Promise<void>;
	onClose?: () => void;
	onError?: (error: unknown) => void;
}

/** Child sessions launched by the active session's subagent tool. */
export class IoSubagentPicker {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly sessions: readonly EngineSessionSummary[];
	private readonly activeID: string | undefined;
	private readonly theme: IoTheme;
	private readonly onSelect: IoSubagentPickerOptions["onSelect"];
	private readonly onClose: (() => void) | undefined;
	private readonly onError: ((error: unknown) => void) | undefined;
	private panel: BoxRenderable | undefined;
	private list: ScrollBoxRenderable | undefined;
	private selected = 0;
	private opened = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoSubagentPickerOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.sessions = options.sessions;
		this.activeID = options.activeID;
		this.theme = options.theme ?? ioDarkTheme;
		this.onSelect = options.onSelect;
		this.onClose = options.onClose;
		this.onError = options.onError;
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get selectedSession(): EngineSessionSummary | undefined {
		return this.sessions[this.selected];
	}

	open(): void {
		if (this.opened) return;
		this.opened = true;
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

	move(delta: number): void {
		if (this.sessions.length === 0) return;
		this.selected = (this.selected + delta + this.sessions.length) % this.sessions.length;
		this.refresh();
	}

	selectCurrent(): boolean {
		const session = this.selectedSession;
		if (!session) return false;
		this.close();
		void Promise.resolve(this.onSelect(session)).catch((error) => this.onError?.(error));
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
			width: "68%",
			maxWidth: 88,
			height: "52%",
			maxHeight: 18,
			border: true,
			borderColor: this.theme.border,
			title: "Subagents",
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
			content: "↑↓ move · enter open · esc close",
			fg: this.theme.muted,
			bg: this.theme.panel,
			height: 1,
			wrapMode: "none",
		});
		panel.add(list);
		panel.add(hint);
		this.list = list;
		return panel;
	}

	private refresh(): void {
		if (!this.list) return;
		clearChildren(this.list);
		if (this.sessions.length === 0) {
			this.list.add(
				new TextRenderable(this.renderer, {
					content: "No subagent sessions",
					fg: this.theme.muted,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
				}),
			);
		}
		for (const [index, session] of this.sessions.entries()) {
			const selected = index === this.selected;
			const active = session.id === this.activeID ? "●" : " ";
			const busy = session.busy ? "working" : "idle";
			const agent = session.agent ? `${session.agent} · ` : "";
			this.list.add(
				new TextRenderable(this.renderer, {
					content: `${selected ? "›" : " "} ${active} ${session.title}  ${agent}${busy}`,
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

function clearChildren(container: { getChildren(): readonly { destroyRecursively(): void }[]; remove(child: never): void }): void {
	for (const child of [...container.getChildren()]) {
		container.remove(child as never);
		child.destroyRecursively();
	}
}
