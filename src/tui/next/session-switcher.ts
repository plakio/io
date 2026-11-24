import {
	BoxRenderable,
	InputRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { EngineSessionSummary } from "../../engine/types.js";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoSessionSwitcherOptions {
	renderer: CliRenderer;
	shell: IoShell;
	sessions: readonly EngineSessionSummary[];
	activeID?: string;
	theme?: IoTheme;
	onSelect: (session: EngineSessionSummary) => void | Promise<void>;
	onRename?: (session: EngineSessionSummary, title: string) => void | Promise<void>;
	onDelete?: (session: EngineSessionSummary) => void | Promise<void>;
	onFork?: (session: EngineSessionSummary) => void | Promise<void>;
	onArchive?: (session: EngineSessionSummary) => void | Promise<void>;
	onSearch?: (query: string) => Promise<readonly EngineSessionSummary[]>;
	onClose?: () => void;
	onError?: (error: unknown) => void;
}

/** Searchable session list with resume, rename, delete and fork hooks. */
export class IoSessionSwitcher {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly theme: IoTheme;
	private readonly callbacks: Pick<
		IoSessionSwitcherOptions,
		"onSelect" | "onRename" | "onDelete" | "onFork" | "onArchive" | "onSearch" | "onClose" | "onError"
	>;
	private sessions: readonly EngineSessionSummary[];
	private activeID: string | undefined;
	private panel: BoxRenderable | undefined;
	private input: InputRenderable | undefined;
	private list: ScrollBoxRenderable | undefined;
	private renameBox: BoxRenderable | undefined;
	private renameInput: InputRenderable | undefined;
	private visible: readonly EngineSessionSummary[] = [];
	private selected = 0;
	private opened = false;
	private renaming = false;
	private searchTimer: NodeJS.Timeout | undefined;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoSessionSwitcherOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.theme = options.theme ?? ioDarkTheme;
		this.sessions = options.sessions;
		this.activeID = options.activeID;
		this.callbacks = options;
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get selectedSession(): EngineSessionSummary | undefined {
		return this.visible[this.selected];
	}

	open(): void {
		if (this.opened) return;
		this.opened = true;
		this.visible = this.sessions;
		this.selected = 0;
		this.panel = this.buildPanel();
		this.shell.showOverlay(this.panel);
		this.input?.focus();
		this.renderer.keyInput.on("keypress", this.keyHandler);
		this.refresh();
		this.renderer.requestRender();
	}

	close(): void {
		if (!this.opened) return;
		this.opened = false;
		this.renaming = false;
		if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
		this.searchTimer = undefined;
		this.renderer.keyInput.off("keypress", this.keyHandler);
		this.input = undefined;
		this.list = undefined;
		this.renameBox = undefined;
		this.renameInput = undefined;
		this.panel = undefined;
		this.shell.hideOverlay();
		this.callbacks.onClose?.();
		this.renderer.requestRender();
	}

	setSessions(sessions: readonly EngineSessionSummary[], activeID?: string): void {
		this.sessions = sessions;
		if (activeID !== undefined) this.activeID = activeID;
		this.visible = this.filter(this.input?.value ?? "");
		this.selected = Math.min(this.selected, Math.max(0, this.visible.length - 1));
		this.refresh();
	}

	setActive(sessionID: string | undefined): void {
		this.activeID = sessionID;
		this.refresh();
	}

	setQuery(query: string): void {
		if (!this.input) return;
		this.input.value = query;
		this.refresh();
		this.scheduleSearch(query);
	}

	move(delta: number): void {
		if (this.visible.length === 0) return;
		this.selected = (this.selected + delta + this.visible.length) % this.visible.length;
		this.refresh();
	}

	selectCurrent(): boolean {
		const session = this.selectedSession;
		if (!session) return false;
		this.close();
		void Promise.resolve(this.callbacks.onSelect(session)).catch((error) => this.callbacks.onError?.(error));
		return true;
	}

	async deleteSelected(): Promise<boolean> {
		const session = this.selectedSession;
		if (!session) return false;
		await this.callbacks.onDelete?.(session);
		this.sessions = this.sessions.filter((entry) => entry.id !== session.id);
		this.refresh();
		return true;
	}

	async archiveSelected(): Promise<boolean> {
		const session = this.selectedSession;
		if (!session) return false;
		await this.callbacks.onArchive?.(session);
		this.sessions = this.sessions.filter((entry) => entry.id !== session.id);
		this.refresh();
		return true;
	}

	async forkSelected(): Promise<boolean> {
		const session = this.selectedSession;
		if (!session) return false;
		await this.callbacks.onFork?.(session);
		this.refresh();
		return true;
	}

	startRename(): boolean {
		const session = this.selectedSession;
		if (!session || !this.renameBox || !this.renameInput || !this.list) return false;
		this.renaming = true;
		this.list.visible = false;
		this.renameBox.visible = true;
		this.renameInput.value = session.title;
		this.renameInput.focus();
		this.renderer.requestRender();
		return true;
	}

	async commitRename(title?: string): Promise<boolean> {
		const session = this.selectedSession;
		if (!session || !this.renameInput) return false;
		const next = (title ?? this.renameInput.value).trim();
		if (!next) return false;
		await this.callbacks.onRename?.(session, next);
		this.sessions = this.sessions.map((entry) => (entry.id === session.id ? { ...entry, title: next } : entry));
		this.cancelRename();
		this.refresh();
		return true;
	}

	cancelRename(): void {
		this.renaming = false;
		if (this.renameBox) this.renameBox.visible = false;
		if (this.list) this.list.visible = true;
		if (this.input) this.input.focus();
		this.renderer.requestRender();
	}

	dispose(): void {
		this.close();
	}

	private handleKey(event: IoKeyEvent): void {
		if (!this.opened || event.defaultPrevented) return;
		const name = event.name.toLowerCase();
		if (this.renaming) {
			if (name === "escape") {
				this.cancelRename();
				event.preventDefault?.();
				event.stopPropagation?.();
				return;
			}
			if (name === "return") {
				void this.commitRename();
				event.preventDefault?.();
				event.stopPropagation?.();
			}
			return;
		}
		if (name === "escape") this.close();
		else if (name === "up") this.move(-1);
		else if (name === "down") this.move(1);
		else if (name === "return") this.selectCurrent();
		else if (event.ctrl && name === "r") this.startRename();
		else if (event.ctrl && name === "d") void this.deleteSelected();
		else if (event.ctrl && name === "f") void this.forkSelected();
		else if (event.ctrl && name === "a") void this.archiveSelected();
		else return;
		event.preventDefault?.();
		event.stopPropagation?.();
	}

	private buildPanel(): BoxRenderable {
		const panel = new BoxRenderable(this.renderer, {
			width: "78%",
			maxWidth: 90,
			height: "62%",
			maxHeight: 24,
			border: true,
			borderColor: this.theme.border,
			title: "Sessions",
			titleColor: this.theme.accent,
			backgroundColor: this.theme.panel,
			padding: 1,
			flexDirection: "column",
			gap: 1,
		});
		const input = new InputRenderable(this.renderer, {
			value: "",
			placeholder: "Search sessions…",
			textColor: this.theme.text,
			backgroundColor: this.theme.panel,
			focusedBackgroundColor: this.theme.panel,
			focusedTextColor: this.theme.text,
			placeholderColor: this.theme.muted,
		});
		input.onContentChange = () => {
			this.refresh();
			this.scheduleSearch(input.value);
		};
		const list = new ScrollBoxRenderable(this.renderer, {
			flexGrow: 1,
			flexShrink: 1,
			scrollY: true,
			backgroundColor: this.theme.panel,
			paddingX: 1,
		});
		const renameBox = new BoxRenderable(this.renderer, {
			flexGrow: 1,
			flexShrink: 1,
			flexDirection: "column",
			visible: false,
			backgroundColor: this.theme.panel,
		});
		const renameInput = new InputRenderable(this.renderer, {
			value: "",
			placeholder: "Session title…",
			textColor: this.theme.text,
			backgroundColor: this.theme.panel,
			focusedBackgroundColor: this.theme.panel,
			focusedTextColor: this.theme.text,
			placeholderColor: this.theme.muted,
		});
		renameBox.add(renameInput);
		renameBox.add(
			new TextRenderable(this.renderer, {
				content: "enter save · esc cancel",
				fg: this.theme.muted,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
			}),
		);
		const hint = new TextRenderable(this.renderer, {
			content: "↑↓ move · enter resume · ctrl+r rename · ctrl+d delete · ctrl+f fork · ctrl+a archive",
			fg: this.theme.muted,
			bg: this.theme.panel,
			height: 1,
			wrapMode: "none",
			truncate: true,
		});
		panel.add(input);
		panel.add(list);
		panel.add(renameBox);
		panel.add(hint);
		this.input = input;
		this.list = list;
		this.renameBox = renameBox;
		this.renameInput = renameInput;
		return panel;
	}

	private refresh(): void {
		if (!this.list || !this.input) return;
		this.visible = this.filter(this.input.value);
		this.selected = Math.min(this.selected, Math.max(0, this.visible.length - 1));
		clearChildren(this.list);
		if (this.visible.length === 0) {
			this.list.add(
				new TextRenderable(this.renderer, {
					content: "No sessions",
					fg: this.theme.muted,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
				}),
			);
		} else {
			this.visible.forEach((session, index) => {
				const selected = index === this.selected;
				const active = session.id === this.activeID ? "●" : " ";
				const date = new Date(session.updatedAt).toISOString().slice(0, 10);
				const row = new TextRenderable(this.renderer, {
					id: `session-row-${index}`,
					content: `${selected ? "›" : " "} ${active} ${session.title}  ${session.id.slice(0, 6)}  ${date}`,
					fg: selected ? this.theme.accent : this.theme.text,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
					truncate: true,
				});
				row.onMouseDown = () => {
					this.selected = index;
					this.refresh();
					this.selectCurrent();
				};
				this.list?.add(row);
			});
		}
		try {
			this.list.scrollTo(0);
		} catch {
			// Layout may not be ready during the first refresh.
		}
		this.renderer.requestRender();
	}

	private scheduleSearch(query: string): void {
		if (!this.callbacks.onSearch) return;
		if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
		const value = query.trim();
		if (value.length < 2) return;
		this.searchTimer = setTimeout(() => {
			void this.callbacks.onSearch?.(value).then((results) => {
				if (!this.opened || this.input?.value.trim() !== value) return;
				this.sessions = results;
				this.refresh();
			});
		}, 250);
		this.searchTimer.unref?.();
	}

	private filter(query: string): readonly EngineSessionSummary[] {
		const value = query.trim().toLowerCase();
		if (!value) return this.sessions;
		return this.sessions.filter((session) =>
			`${session.title} ${session.id} ${session.directory ?? ""}`.toLowerCase().includes(value),
		);
	}
}

function clearChildren(container: { getChildren(): readonly { destroyRecursively(): void }[]; remove(child: never): void }): void {
	for (const child of [...container.getChildren()]) {
		container.remove(child as never);
		child.destroyRecursively();
	}
}
