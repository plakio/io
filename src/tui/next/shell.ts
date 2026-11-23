import {
	BoxRenderable,
	ScrollBoxRenderable,
	TextareaRenderable,
	TextRenderable,
	type CliRenderer,
	type Renderable,
} from "@opentui/core";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoShellTab {
	id: string;
	label: string;
	status?: "idle" | "busy" | "error";
}

export interface IoShellFooter {
	cwd?: string;
	branch?: string;
	model?: string;
	context?: string;
	tokens?: string;
	tps?: string;
	cost?: string;
	queue?: number;
	mode?: string;
}

export interface IoShellOptions {
	cwd: string;
	version: string;
	branch?: string;
	sessionID?: string;
	model?: string;
	theme?: IoTheme;
	showTps?: boolean;
}

export type ToastKind = "info" | "success" | "warning" | "error" | "permission";

export interface ToastOptions {
	/** Milliseconds before dismissal. Zero or a negative value keeps it visible. */
	durationMs?: number;
	/** Keep the toast until clearToasts() or dismissToast(). */
	persistent?: boolean;
}

/**
 * Layout A · io Focus: top bar, optional tabs, transcript, composer and footer
 * as the only permanent regions. Overlays and toasts live in absolute layers.
 *
 * The shell owns composition only. It consumes plain view state, not OpenCode
 * or Pi types, so the engine can be swapped underneath it.
 */
export class IoShell {
	private readonly renderer: CliRenderer;
	private theme: IoTheme;
	private readonly root: BoxRenderable;
	private readonly header: BoxRenderable;
	private readonly headerLeft: BoxRenderable;
	private readonly ioLabel: TextRenderable;
	private readonly versionLabel: TextRenderable;
	private readonly cwdLabel: TextRenderable;
	private readonly branchLabel: TextRenderable;
	private readonly sessionLabel: TextRenderable;
	private readonly tabs: BoxRenderable;
	private readonly transcript: ScrollBoxRenderable;
	private readonly composerPanel: BoxRenderable;
	readonly composer: TextareaRenderable;
	private readonly footer: BoxRenderable;
	private readonly footerLeft: TextRenderable;
	private readonly footerRight: TextRenderable;
	private readonly overlayLayer: BoxRenderable;
	private readonly toastLayer: BoxRenderable;
	private readonly floatingLayer: BoxRenderable;
	private overlayChild: Renderable | undefined;
	private floatingChild: Renderable | undefined;
	private readonly toastTimers = new Map<string, NodeJS.Timeout>();
	private toastCounter = 0;
	private readonly onResize: () => void;
	private tabsState: readonly IoShellTab[] = [];
	private activeTabID: string | undefined;
	private footerState: IoShellFooter = {};
	private width: number;
	private showTps: boolean;

	constructor(renderer: CliRenderer, options: IoShellOptions) {
		this.renderer = renderer;
		this.theme = options.theme ?? ioDarkTheme;
		this.showTps = options.showTps !== false;
		this.width = renderer.width;

		this.root = new BoxRenderable(renderer, {
			flexDirection: "column",
			width: "100%",
			height: "100%",
			backgroundColor: this.theme.background,
		});
		renderer.root.add(this.root);

		this.header = new BoxRenderable(renderer, {
			height: 1,
			flexDirection: "row",
			justifyContent: "space-between",
			alignItems: "center",
			paddingX: 1,
			backgroundColor: this.theme.panel,
		});
		this.headerLeft = new BoxRenderable(renderer, {
			flexDirection: "row",
			gap: 1,
			height: 1,
		});
		this.ioLabel = this.text("io", this.theme.accent, this.theme.panel);
		this.versionLabel = this.text(options.version, this.theme.muted, this.theme.panel);
		this.cwdLabel = this.text(options.cwd, this.theme.text, this.theme.panel, true);
		this.branchLabel = this.text(options.branch ?? "", this.theme.muted, this.theme.panel);
		this.headerLeft.add(this.ioLabel);
		this.headerLeft.add(this.versionLabel);
		this.headerLeft.add(this.cwdLabel);
		this.headerLeft.add(this.branchLabel);
		this.sessionLabel = this.text(options.sessionID ? `session ${options.sessionID}` : "", this.theme.muted, this.theme.panel);
		this.header.add(this.headerLeft);
		this.header.add(this.sessionLabel);
		this.root.add(this.header);

		this.tabs = new BoxRenderable(renderer, {
			height: 1,
			flexDirection: "row",
			gap: 2,
			paddingX: 1,
			backgroundColor: this.theme.panel,
			visible: false,
		});
		this.root.add(this.tabs);

		this.transcript = new ScrollBoxRenderable(renderer, {
			flexGrow: 1,
			flexShrink: 1,
			minHeight: 1,
			paddingX: 1,
			scrollY: true,
			scrollX: false,
			stickyScroll: true,
			stickyStart: "bottom",
			backgroundColor: this.theme.background,
		});
		this.root.add(this.transcript);

		this.composerPanel = new BoxRenderable(renderer, {
			flexShrink: 0,
			height: 4,
			border: ["top"],
			borderColor: this.theme.border,
			backgroundColor: this.theme.background,
			paddingX: 1,
		});
		this.composer = new TextareaRenderable(renderer, {
			height: 3,
			initialValue: "",
			placeholder: "Ask io…  (/help for commands)",
			placeholderColor: this.theme.muted,
			textColor: this.theme.text,
			backgroundColor: this.theme.background,
			focusedBackgroundColor: this.theme.background,
			focusedTextColor: this.theme.text,
		});
		this.composerPanel.add(this.composer);
		this.root.add(this.composerPanel);
		this.composer.focus();

		this.footer = new BoxRenderable(renderer, {
			height: 1,
			flexDirection: "row",
			justifyContent: "space-between",
			paddingX: 1,
			backgroundColor: this.theme.panel,
		});
		this.footerLeft = this.text(options.cwd, this.theme.muted, this.theme.panel, true);
		this.footerRight = this.text("", this.theme.muted, this.theme.panel);
		this.footer.add(this.footerLeft);
		this.footer.add(this.footerRight);
		this.root.add(this.footer);

		this.overlayLayer = new BoxRenderable(renderer, {
			position: "absolute",
			top: 0,
			left: 0,
			right: 0,
			bottom: 0,
			zIndex: 10,
			visible: false,
			alignItems: "center",
			justifyContent: "center",
			padding: 2,
			backgroundColor: this.theme.background,
		});
		this.root.add(this.overlayLayer);

		this.toastLayer = new BoxRenderable(renderer, {
			position: "absolute",
			top: 1,
			right: 2,
			width: 44,
			flexDirection: "column",
			gap: 1,
			zIndex: 20,
			visible: false,
		});
		this.root.add(this.toastLayer);

		this.floatingLayer = new BoxRenderable(renderer, {
			position: "absolute",
			bottom: 1,
			right: 1,
			width: 48,
			maxWidth: "90%",
			zIndex: 15,
			visible: false,
			border: true,
			borderColor: this.theme.border,
			backgroundColor: this.theme.panel,
			paddingX: 1,
			paddingY: 1,
		});
		this.root.add(this.floatingLayer);

		this.footerState = { cwd: options.cwd, model: options.model };
		this.updateFooter();
		this.applyWidth(this.width);
		this.onResize = () => this.applyWidth(this.renderer.width);
		this.renderer.on("resize", this.onResize);
	}

	get currentTheme(): IoTheme {
		return this.theme;
	}

	setTheme(theme: IoTheme): void {
		this.theme = theme;
		this.root.backgroundColor = theme.background;
		this.header.backgroundColor = theme.panel;
		this.ioLabel.fg = theme.accent;
		this.ioLabel.bg = theme.panel;
		this.versionLabel.fg = theme.muted;
		this.versionLabel.bg = theme.panel;
		this.cwdLabel.fg = theme.text;
		this.cwdLabel.bg = theme.panel;
		this.branchLabel.fg = theme.muted;
		this.branchLabel.bg = theme.panel;
		this.sessionLabel.fg = theme.muted;
		this.sessionLabel.bg = theme.panel;
		this.tabs.backgroundColor = theme.panel;
		this.transcript.backgroundColor = theme.background;
		this.composerPanel.backgroundColor = theme.background;
		this.composerPanel.borderColor = theme.border;
		this.composer.backgroundColor = theme.background;
		this.composer.focusedBackgroundColor = theme.background;
		this.composer.textColor = theme.text;
		this.composer.focusedTextColor = theme.text;
		this.composer.placeholderColor = theme.muted;
		this.footer.backgroundColor = theme.panel;
		this.footerLeft.fg = theme.muted;
		this.footerLeft.bg = theme.panel;
		this.footerRight.fg = theme.muted;
		this.footerRight.bg = theme.panel;
		this.overlayLayer.backgroundColor = theme.background;
		this.floatingLayer.borderColor = theme.border;
		this.floatingLayer.backgroundColor = theme.panel;
		this.rebuildTabs();
		this.updateFooter();
		this.renderer.requestRender();
	}

	get transcriptContainer(): ScrollBoxRenderable {
		return this.transcript;
	}

	setHeader(header: { cwd?: string; branch?: string; sessionID?: string }): void {
		if (header.cwd !== undefined) this.cwdLabel.content = header.cwd;
		if (header.branch !== undefined) this.branchLabel.content = header.branch;
		if (header.sessionID !== undefined) {
			this.sessionLabel.content = header.sessionID ? `session ${header.sessionID}` : "";
		}
		this.footerState = { ...this.footerState, ...header };
		this.updateFooter();
		this.renderer.requestRender();
	}

	setTabs(tabs: readonly IoShellTab[], activeID?: string): void {
		this.tabsState = tabs;
		this.activeTabID = activeID ?? tabs.find((tab) => tab.status === "busy")?.id ?? tabs[0]?.id;
		this.rebuildTabs();
		this.renderer.requestRender();
	}

	setFooter(state: IoShellFooter): void {
		this.footerState = { ...this.footerState, ...state };
		this.updateFooter();
		this.renderer.requestRender();
	}

	setShowTps(show: boolean): void {
		this.showTps = show;
		this.updateFooter();
		this.renderer.requestRender();
	}

	setTranscriptPlaceholder(content: string): void {
		this.clearTranscript();
		const text = new TextRenderable(this.renderer, {
			content,
			fg: this.theme.muted,
			bg: this.theme.background,
			wrapMode: "word",
			selectable: false,
		});
		this.transcript.add(text);
		this.renderer.requestRender();
	}

	setWidth(width: number): void {
		this.applyWidth(width);
	}

	addTranscriptChild(child: Renderable): void {
		this.transcript.add(child);
		this.renderer.requestRender();
	}

	clearTranscript(): void {
		clearChildren(this.transcript);
		this.renderer.requestRender();
	}

	showOverlay(child: Renderable): void {
		this.clearOverlay();
		this.overlayChild = child;
		this.overlayLayer.add(child);
		this.overlayLayer.visible = true;
		this.renderer.requestRender();
	}

	hideOverlay(): void {
		this.clearOverlay();
		this.overlayLayer.visible = false;
		this.renderer.requestRender();
	}

	showFloating(child: Renderable): void {
		this.hideFloating();
		this.floatingChild = child;
		this.floatingLayer.add(child);
		this.floatingLayer.visible = true;
		this.renderer.requestRender();
	}

	hideFloating(): void {
		if (this.floatingChild) {
			this.floatingLayer.remove(this.floatingChild);
			this.floatingChild.destroyRecursively();
			this.floatingChild = undefined;
		}
		clearChildren(this.floatingLayer);
		this.floatingLayer.visible = false;
		this.renderer.requestRender();
	}

	toast(message: string, kind: ToastKind = "info", options: number | ToastOptions = {}): string {
		const settings = typeof options === "number" ? { durationMs: options } : options;
		const persistent = settings.persistent === true || settings.durationMs === 0 || (settings.durationMs ?? 0) < 0;
		const duration =
			settings.durationMs ??
			(kind === "error" || kind === "permission" ? 0 : kind === "warning" ? 6_000 : kind === "success" ? 3_000 : 4_000);
		const color =
			kind === "success"
				? this.theme.success
				: kind === "warning"
					? this.theme.warning
					: kind === "error"
						? this.theme.error
						: kind === "permission"
							? this.theme.warning
							: this.theme.text;
		const icon =
			kind === "success" ? "✔" : kind === "warning" || kind === "permission" ? "!" : kind === "error" ? "✖" : "•";
		const id = `toast-${++this.toastCounter}`;
		const card = new BoxRenderable(this.renderer, {
			id,
			width: "100%",
			flexDirection: "column",
			border: ["left"],
			borderColor: color,
			paddingLeft: 1,
			backgroundColor: this.theme.panel,
		});
		card.add(
			new TextRenderable(this.renderer, {
				content: `${icon} ${message}`,
				fg: color,
				bg: this.theme.panel,
				wrapMode: "word",
				truncate: false,
			}),
		);
		this.toastLayer.add(card);
		this.toastLayer.visible = true;
		this.trimToasts(id);
		this.renderer.requestRender();
		if (!persistent && duration > 0) {
			const timer = setTimeout(() => this.dismissToast(id), duration);
			timer.unref?.();
			this.toastTimers.set(id, timer);
		}
		return id;
	}

	dismissToast(id: string): void {
		const timer = this.toastTimers.get(id);
		if (timer) clearTimeout(timer);
		this.toastTimers.delete(id);
		const card = this.toastLayer.getChildren().find((child) => child.id === id);
		if (card) {
			this.toastLayer.remove(card);
			card.destroyRecursively();
		}
		if (this.toastLayer.getChildrenCount() === 0) this.toastLayer.visible = false;
		this.renderer.requestRender();
	}

	clearToasts(): void {
		for (const timer of this.toastTimers.values()) clearTimeout(timer);
		this.toastTimers.clear();
		clearChildren(this.toastLayer);
		this.toastLayer.visible = false;
		this.renderer.requestRender();
	}

	private trimToasts(keepID: string): void {
		while (this.toastLayer.getChildrenCount() > 3) {
			const oldest = this.toastLayer.getChildren().find((child) => child.id !== keepID);
			if (!oldest) break;
			this.dismissToast(oldest.id);
		}
	}

	focusComposer(): void {
		this.composer.focus();
		this.renderer.requestRender();
	}

	dispose(): void {
		for (const timer of this.toastTimers.values()) clearTimeout(timer);
		this.toastTimers.clear();
		this.renderer.off("resize", this.onResize);
	}

	private text(
		content: string,
		fg: string,
		bg: string,
		truncate = false,
	): TextRenderable {
		return new TextRenderable(this.renderer, {
			content,
			fg,
			bg,
			height: 1,
			wrapMode: "none",
			truncate,
			selectable: false,
		});
	}

	private rebuildTabs(): void {
		clearChildren(this.tabs);
		this.tabs.visible = this.tabsState.length > 1;
		if (!this.tabs.visible) return;
		const compact = this.width < 80;
		for (const tab of this.tabsState) {
			const active = tab.id === this.activeTabID;
			const status = tab.status === "error" ? "!" : tab.status === "busy" ? "•" : "";
			const label = compact ? tab.id : `${tab.id} ${tab.label}`;
			const content = status ? `${status} ${label}` : `  ${label}`;
			const color = tab.status === "error" ? this.theme.error : active ? this.theme.accent : this.theme.muted;
			this.tabs.add(this.text(content, color, this.theme.panel));
		}
	}

	private updateFooter(): void {
		const state = this.footerState;
		const left = [state.cwd, state.branch, state.model].filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		);
		const wide = this.width >= 120;
		const medium = this.width >= 90;
		const right = [
			state.context ? `ctx ${state.context}` : undefined,
			state.tokens,
			this.showTps ? state.tps : undefined,
			wide ? state.cost : undefined,
			wide && state.queue && state.queue > 0 ? `queue ${state.queue}` : undefined,
			wide ? state.mode : undefined,
		].filter((value): value is string => typeof value === "string" && value.length > 0);
		const compact = this.width < 80;
		const narrow = this.width < 60;
		this.footerLeft.content = (narrow ? left.slice(0, 1) : compact ? left.slice(0, 2) : left).join(" · ");
		this.footerRight.content = (medium ? right : right.slice(0, 1)).join(" · ");
	}

	private applyWidth(width: number): void {
		this.width = width;
		this.versionLabel.visible = width >= 90;
		this.branchLabel.visible = width >= 80;
		this.sessionLabel.visible = width >= 60;
		this.rebuildTabs();
		this.updateFooter();
		this.renderer.requestRender();
	}

	private clearOverlay(): void {
		if (this.overlayChild) {
			this.overlayLayer.remove(this.overlayChild);
			this.overlayChild.destroyRecursively();
			this.overlayChild = undefined;
		}
		clearChildren(this.overlayLayer);
	}
}

function clearChildren(container: Renderable): void {
	for (const child of [...container.getChildren()]) {
		container.remove(child);
		child.destroyRecursively();
	}
}
