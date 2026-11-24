import {
	BoxRenderable,
	EmbeddedTerminalRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import { spawn } from "node:child_process";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface PtyProcess {
	write(data: string | Uint8Array): void;
	resize(cols: number, rows: number): void;
	kill(): void;
	onData(listener: (data: string | Uint8Array) => void): void;
}

export type PtySpawn = (input: { cwd: string; cols: number; rows: number }) => PtyProcess;

export interface IoTerminalPaneOptions {
	renderer: CliRenderer;
	shell: IoShell;
	cwd: string;
	spawn?: PtySpawn;
	theme?: IoTheme;
	onClose?: () => void;
	onError?: (error: unknown) => void;
}

/** Embedded shell terminal backed by a real PTY. F12 closes the pane. */
export class IoTerminalPane {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly cwd: string;
	private readonly spawn: PtySpawn;
	private readonly theme: IoTheme;
	private readonly onClose: (() => void) | undefined;
	private readonly onError: ((error: unknown) => void) | undefined;
	private terminal: EmbeddedTerminalRenderable | undefined;
	private process: PtyProcess | undefined;
	private opened = false;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoTerminalPaneOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.cwd = options.cwd;
		this.spawn = options.spawn ?? defaultSpawn;
		this.theme = options.theme ?? ioDarkTheme;
		this.onClose = options.onClose;
		this.onError = options.onError;
		this.keyHandler = (event) => {
			if (!this.opened) return;
			if (event.name.toLowerCase() !== "f12") return;
			event.preventDefault?.();
			event.stopPropagation?.();
			this.close();
		};
	}

	get isOpen(): boolean {
		return this.opened;
	}

	open(): void {
		if (this.opened) return;
		const panel = new BoxRenderable(this.renderer, {
			width: "100%",
			height: "100%",
			border: true,
			borderColor: this.theme.border,
			title: "Terminal · F12 close",
			titleColor: this.theme.accent,
			backgroundColor: this.theme.background,
			flexDirection: "column",
			padding: 1,
		});
		const terminal = new EmbeddedTerminalRenderable(this.renderer, {
			flexGrow: 1,
			flexShrink: 1,
			width: "100%",
			cols: Math.max(20, this.renderer.width - 4),
			rows: Math.max(5, this.renderer.height - 4),
			transparentBackground: false,
		});
		const hint = new TextRenderable(this.renderer, {
			content: "F12 closes the terminal",
			fg: this.theme.muted,
			bg: this.theme.background,
			height: 1,
			wrapMode: "none",
		});
		panel.add(terminal);
		panel.add(hint);
		this.terminal = terminal;
		this.opened = true;
		this.shell.showOverlay(panel);
		this.renderer.keyInput.prependListener("keypress", this.keyHandler);
		terminal.onData = (data) => this.process?.write(data);
		terminal.onTerminalResize = (cols, rows) => this.process?.resize(Math.max(2, cols), Math.max(2, rows));
		terminal.focus();
		try {
			this.process = this.spawn({
				cwd: this.cwd,
				cols: Math.max(20, this.renderer.width - 4),
				rows: Math.max(5, this.renderer.height - 4),
			});
			this.process.onData((data) => terminal.write(data));
		} catch (error) {
			this.onError?.(error);
		}
		this.renderer.requestRender();
	}

	close(): void {
		if (!this.opened) return;
		this.opened = false;
		this.renderer.keyInput.off("keypress", this.keyHandler);
		try {
			this.process?.kill();
		} catch {
			// Best effort.
		}
		this.process = undefined;
		this.terminal?.destroyRecursively();
		this.terminal = undefined;
		this.shell.hideOverlay();
		this.onClose?.();
		this.renderer.requestRender();
	}

	dispose(): void {
		this.close();
	}
}

function defaultSpawn(input: { cwd: string; cols: number; rows: number }): PtyProcess {
	const shell = process.env.SHELL || "/bin/sh";
	const args =
		process.platform === "darwin"
			? ["-q", "/dev/null", shell, "-i"]
			: ["-qefc", `${shell} -i`, "/dev/null"];
	const child = spawn("script", args, {
		cwd: input.cwd,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const queue: Array<string | Uint8Array> = [];
	let listener: ((data: string | Uint8Array) => void) | undefined;
	const emit = (data: string | Uint8Array) => {
		if (listener) listener(data);
		else queue.push(data);
	};
	child.stdout.on("data", (buffer: Buffer) => emit(buffer.toString("utf8")));
	child.stderr.on("data", (buffer: Buffer) => emit(buffer.toString("utf8")));
	const resize = (cols: number, rows: number) => {
		if (child.stdin.writable) child.stdin.write(`stty cols ${cols} rows ${rows}\n`);
	};
	resize(input.cols, input.rows);
	return {
		write: (data) => {
			if (!child.stdin.writable) return;
			child.stdin.write(typeof data === "string" ? data : Buffer.from(data));
		},
		resize,
		kill: () => {
			child.kill("SIGTERM");
		},
		onData: (next) => {
			listener = next;
			for (const data of queue.splice(0)) next(data);
		},
	};
}
