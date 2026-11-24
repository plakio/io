import {
	BoxRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { EngineSkill } from "../../engine/types.js";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoSkillsPanelOptions {
	renderer: CliRenderer;
	shell: IoShell;
	skills: readonly EngineSkill[];
	theme?: IoTheme;
	onSelect: (skill: EngineSkill) => Promise<void> | void;
	onClose?: () => void;
	onError?: (error: unknown) => void;
}

/** Skill catalogue; enter activates the skill on the active session. */
export class IoSkillsPanel {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly skills: readonly EngineSkill[];
	private readonly theme: IoTheme;
	private readonly onSelect: IoSkillsPanelOptions["onSelect"];
	private readonly onClose: (() => void) | undefined;
	private readonly onError: ((error: unknown) => void) | undefined;
	private panel: BoxRenderable | undefined;
	private list: ScrollBoxRenderable | undefined;
	private selected = 0;
	private opened = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoSkillsPanelOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.skills = options.skills;
		this.theme = options.theme ?? ioDarkTheme;
		this.onSelect = options.onSelect;
		this.onClose = options.onClose;
		this.onError = options.onError;
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get selectedSkill(): EngineSkill | undefined {
		return this.skills[this.selected];
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
		if (this.skills.length === 0) return;
		this.selected = (this.selected + delta + this.skills.length) % this.skills.length;
		this.refresh();
	}

	selectCurrent(): boolean {
		const skill = this.selectedSkill;
		if (!skill) return false;
		this.close();
		void Promise.resolve(this.onSelect(skill)).catch((error) => this.onError?.(error));
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
			maxWidth: 92,
			height: "58%",
			maxHeight: 20,
			border: true,
			borderColor: this.theme.border,
			title: "Skills",
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
			content: "↑↓ move · enter activate · esc close",
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
		if (this.skills.length === 0) {
			this.list.add(
				new TextRenderable(this.renderer, {
					content: "No skills found",
					fg: this.theme.muted,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
				}),
			);
		}
		for (const [index, skill] of this.skills.entries()) {
			const selected = index === this.selected;
			this.list.add(
				new TextRenderable(this.renderer, {
					content: `${selected ? "›" : " "} ${skill.name}`,
					fg: selected ? this.theme.accent : this.theme.text,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
				}),
			);
			if (skill.description) {
				this.list.add(
					new TextRenderable(this.renderer, {
						content: `   ${skill.description}`,
						fg: this.theme.muted,
						bg: this.theme.panel,
						height: 1,
						wrapMode: "none",
						truncate: true,
					}),
				);
			}
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
