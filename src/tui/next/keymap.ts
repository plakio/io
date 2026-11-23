import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoKeyEvent {
	name: string;
	ctrl?: boolean;
	shift?: boolean;
	meta?: boolean;
	option?: boolean;
	alt?: boolean;
	super?: boolean;
	sequence?: string;
	defaultPrevented?: boolean;
	preventDefault?: () => void;
	stopPropagation?: () => void;
}

export interface IoCommand {
	id: string;
	title: string;
	description?: string;
	/** OpenCode-style bindings: `ctrl+p`, `<leader>m`, `leader+return`, ... */
	keys?: readonly string[];
	run: () => void | Promise<void>;
}

export interface IoKeymapOptions {
	renderer: CliRenderer;
	shell?: IoShell;
	commands: readonly IoCommand[];
	leader?: string;
	leaderTimeout?: number;
	theme?: IoTheme;
	onLeader?: (entries: readonly IoKeymapEntry[]) => void;
	onError?: (error: unknown) => void;
}

export interface IoKeymapEntry {
	keys: string;
	command: IoCommand;
}

/** Resolves global keys and leader sequences, and renders the which-key panel. */
export class IoKeymap {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell | undefined;
	private readonly theme: IoTheme;
	private readonly commandsById = new Map<string, IoCommand>();
	private readonly bindings = new Map<string, IoCommand>();
	private readonly leaderBindings: IoKeymapEntry[] = [];
	private readonly allBindings: IoKeymapEntry[] = [];
	private readonly onLeader: ((entries: readonly IoKeymapEntry[]) => void) | undefined;
	private readonly onError: ((error: unknown) => void) | undefined;
	private readonly leader: string;
	private readonly leaderTimeout: number;
	private pendingLeader = false;
	private leaderTimer: NodeJS.Timeout | undefined;
	private suspended = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoKeymapOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.theme = options.theme ?? ioDarkTheme;
		this.onLeader = options.onLeader;
		this.onError = options.onError;
		this.leader = normalizeBinding(options.leader ?? "ctrl+x");
		this.leaderTimeout = Math.max(100, options.leaderTimeout ?? 1_500);
		for (const command of options.commands) {
			this.commandsById.set(command.id, command);
			for (const raw of command.keys ?? []) {
				if (raw === "leader") continue;
				const keys = normalizeBinding(raw, this.leader);
				this.bindings.set(keys, command);
				const entry = { keys: raw, command };
				this.allBindings.push(entry);
				if (raw.startsWith("<leader>") || raw.startsWith("leader+")) this.leaderBindings.push(entry);
			}
		}
		this.keyHandler = (event) => {
			if (!this.handleKey(event)) return;
			event.preventDefault?.();
			event.stopPropagation?.();
		};
		this.renderer.keyInput.on("keypress", this.keyHandler);
	}

	get commandBindings(): readonly IoKeymapEntry[] {
		return this.allBindings;
	}

	get isLeaderPending(): boolean {
		return this.pendingLeader;
	}

	setSuspended(suspended: boolean): void {
		this.suspended = suspended;
		if (suspended) this.cancelLeader();
	}

	handleKey(event: IoKeyEvent): boolean {
		if (this.suspended) return false;
		const key = keyId(event);
		if (!key) return false;

		if (this.pendingLeader) {
			this.cancelLeader();
			const command = this.bindings.get(`${this.leader}+${key}`);
			if (!command) return false;
			this.run(command);
			return true;
		}

		if (key === this.leader) {
			this.pendingLeader = true;
			this.showLeader();
			this.leaderTimer = setTimeout(() => this.cancelLeader(), this.leaderTimeout);
			this.leaderTimer.unref?.();
			return true;
		}

		const command = this.bindings.get(key);
		if (!command) return false;
		this.run(command);
		return true;
	}

	showAllBindings(): void {
		this.showPanel("Keys", this.allBindings);
	}

	showLeaderBindings(): void {
		this.showPanel("Leader", this.leaderBindings);
	}

	dispose(): void {
		this.renderer.keyInput.off("keypress", this.keyHandler);
		this.cancelLeader();
	}

	private run(command: IoCommand): void {
		try {
			const result = command.run();
			if (result && typeof (result as Promise<void>).catch === "function") {
				(result as Promise<void>).catch((error) => this.onError?.(error));
			}
		} catch (error) {
			this.onError?.(error);
		}
	}

	private cancelLeader(): void {
		if (this.leaderTimer !== undefined) clearTimeout(this.leaderTimer);
		this.leaderTimer = undefined;
		this.pendingLeader = false;
		if (this.shell) this.shell.hideFloating();
	}

	private showLeader(): void {
		this.onLeader?.(this.leaderBindings);
		this.showPanel("Leader", this.leaderBindings);
	}

	private showPanel(title: string, entries: readonly IoKeymapEntry[]): void {
		if (!this.shell) return;
		const panel = new BoxRenderable(this.renderer, {
			flexDirection: "column",
			width: "100%",
			backgroundColor: this.theme.panel,
		});
		panel.add(
			new TextRenderable(this.renderer, {
				content: title,
				fg: this.theme.accent,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
			}),
		);
		for (const entry of entries.slice(0, 12)) {
			panel.add(
				new TextRenderable(this.renderer, {
					content: `${entry.keys.padEnd(18)} ${entry.command.title}`,
					fg: this.theme.text,
					bg: this.theme.panel,
					wrapMode: "none",
					truncate: true,
				}),
			);
		}
		this.shell.showFloating(panel);
	}
}

function keyId(event: IoKeyEvent): string {
	if (event.defaultPrevented) return "";
	const name = (event.name === " " ? "space" : event.name).toLowerCase();
	if (!name || name === "shift" || name === "control" || name === "alt" || name === "meta") return "";
	const modifiers: string[] = [];
	if (event.ctrl) modifiers.push("ctrl");
	if (event.alt || event.option) modifiers.push("alt");
	if (event.meta) modifiers.push("meta");
	if (event.shift) modifiers.push("shift");
	if (event.super) modifiers.push("super");
	return [...modifiers, name].join("+");
}

function normalizeBinding(binding: string, leader = "ctrl+x"): string {
	const value = binding.trim().toLowerCase();
	if (value === "leader") return leader;
	if (value.startsWith("<leader>")) return `${leader}+${value.slice("<leader>".length)}`;
	if (value.startsWith("leader+")) return `${leader}+${value.slice("leader+".length)}`;
	return value;
}
