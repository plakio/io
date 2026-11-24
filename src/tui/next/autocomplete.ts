import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	BoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { IoCompletionItem } from "./composer.js";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

const execFileAsync = promisify(execFile);

export interface IoAutocompleteOptions {
	renderer: CliRenderer;
	shell: IoShell;
	completions: readonly IoCompletionItem[];
	/** Current working directory, read lazily so /cd is reflected. */
	cwd: () => string;
	/** Inject for tests or non-git workspaces. */
	workspaceFiles?: (cwd: string) => Promise<readonly string[]>;
	/** Subagents available through @mentions. */
	agents?: () => readonly { id: string; name: string; description?: string }[];
	theme?: IoTheme;
	onAccept: (text: string) => void;
}

type Mode = "command" | "file";
type Match = IoCompletionItem & { absolute?: string };

/** Floating completion menu for slash commands and @file paths. */
export class IoAutocomplete {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private completions: readonly IoCompletionItem[];
	private readonly cwd: () => string;
	private readonly workspaceFiles: (cwd: string) => Promise<readonly string[]>;
	private readonly agents: () => readonly { id: string; name: string; description?: string }[];
	private readonly theme: IoTheme;
	private readonly onAccept: (text: string) => void;
	private mode: Mode | undefined;
	private tokenStart = 0;
	private currentText = "";
	private matches: readonly Match[] = [];
	private selected = 0;
	private dismissedFor: string | undefined;
	private files: readonly string[] = [];
	private filesFor: string | undefined;
	private fileRequest = 0;

	constructor(options: IoAutocompleteOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.completions = options.completions;
		this.cwd = options.cwd;
		this.workspaceFiles = options.workspaceFiles ?? workspaceFiles;
		this.agents = options.agents ?? (() => []);
		this.theme = options.theme ?? ioDarkTheme;
		this.onAccept = options.onAccept;
	}

	get visible(): boolean {
		return this.mode !== undefined;
	}

	setCompletions(completions: readonly IoCompletionItem[]): void {
		this.completions = completions;
	}

	get selectedMatch(): Match | undefined {
		return this.matches[this.selected];
	}

	get isCommand(): boolean {
		return this.mode === "command";
	}

	update(text: string): void {
		this.currentText = text;
		if (text === this.dismissedFor) return;
		this.dismissedFor = undefined;

		const command = /^\/([^\s/]*)$/.exec(text);
		if (command) {
			this.mode = "command";
			this.tokenStart = 0;
			const query = command[1] ?? "";
			this.matches = this.completions
				.map((completion) => ({ completion, score: completionScore(completion, query) }))
				.filter((entry) => entry.score !== undefined)
				.sort((left, right) => (left.score ?? 0) - (right.score ?? 0))
				.map((entry) => entry.completion);
			this.selected = 0;
			this.render();
			return;
		}

		const file = /(?:^|\s)@([^\s]*)$/.exec(text);
		if (file) {
			this.mode = "file";
			this.tokenStart = text.length - (file[1]?.length ?? 0) - 1;
			const query = file[1] ?? "";
			void this.loadFiles(query);
			return;
		}
		this.hide();
	}

	handleKey(event: IoKeyEvent): boolean {
		if (!this.visible || event.defaultPrevented) return false;
		const name = event.name.toLowerCase();
		if (name === "escape") {
			this.dismiss();
			return true;
		}
		if (name === "up") {
			this.move(-1);
			return true;
		}
		if (name === "down") {
			this.move(1);
			return true;
		}
		if (name === "tab") {
			if (event.ctrl || event.meta || event.alt || event.option) return false;
			this.accept();
			return true;
		}
		return false;
	}

	/** Accept the current selection and return it, if any. */
	accept(): Match | undefined {
		const match = this.selectedMatch;
		if (!match || this.mode === undefined) return undefined;
		const replacement =
			this.mode === "command" ? `${match.value} ` : `${this.currentText.slice(0, this.tokenStart)}@${match.absolute ?? match.value} `;
		this.hide();
		this.onAccept(replacement);
		return match;
	}

	hide(): void {
		if (this.mode === undefined) return;
		this.mode = undefined;
		this.matches = [];
		this.selected = 0;
		this.shell.hideComposerMenu();
	}

	dispose(): void {
		this.hide();
	}

	private dismiss(): void {
		this.dismissedFor = this.currentText;
		this.hide();
	}

	private move(delta: number): void {
		if (this.matches.length === 0) return;
		this.selected = (this.selected + delta + this.matches.length) % this.matches.length;
		this.render();
	}

	private async loadFiles(query: string): Promise<void> {
		const request = ++this.fileRequest;
		const directory = this.cwd();
		if (this.filesFor !== directory) {
			this.filesFor = directory;
			this.files = await this.workspaceFiles(directory);
		}
		if (request !== this.fileRequest || this.mode !== "file") return;
		const needle = query.toLowerCase();
		const agents = this.agents()
			.filter(
				(agent) =>
					needle.length === 0 ||
					`${agent.id} ${agent.name} ${agent.description ?? ""}`.toLowerCase().includes(needle),
			)
			.map((agent) => ({
				value: agent.id,
				description: `agent · ${agent.description ?? agent.name}`,
				kind: "agent" as const,
			}));
		const files = this.files
			.filter((file) => needle.length === 0 || file.toLowerCase().includes(needle))
			.map((file) => ({
				value: file,
				absolute: file,
				description: "file",
				kind: "path" as const,
			}))
			.slice(0, 10);
		this.matches = [...agents, ...files].slice(0, 10);
		this.selected = 0;
		this.render();
	}

	private render(): void {
		const panel = new BoxRenderable(this.renderer, {
			flexDirection: "column",
			width: "100%",
			backgroundColor: this.theme.panel,
		});
		panel.add(
			new TextRenderable(this.renderer, {
				content: this.mode === "command" ? "Commands" : "Files",
				fg: this.theme.accent,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
			}),
		);
		if (this.matches.length === 0) {
			panel.add(
				new TextRenderable(this.renderer, {
					content: this.mode === "command" ? "No matching commands" : "No matching files",
					fg: this.theme.muted,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
				}),
			);
		}
		for (const [index, match] of this.matches.entries()) {
			const selected = index === this.selected;
			const value = match.value.padEnd(this.mode === "command" ? 14 : 0);
			panel.add(
				new TextRenderable(this.renderer, {
					content: `${selected ? "›" : " "} ${value}${match.description ? `  ${match.description}` : ""}`,
					fg: selected ? this.theme.accent : this.theme.text,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
					truncate: true,
				}),
			);
		}
		panel.add(
			new TextRenderable(this.renderer, {
				content: "↑↓ move · tab complete · enter run · esc close",
				fg: this.theme.muted,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
			}),
		);
		this.shell.showComposerMenu(panel);
		this.renderer.requestRender();
	}
}

async function workspaceFiles(cwd: string): Promise<readonly string[]> {
	try {
		const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
			cwd,
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
			timeout: 10_000,
		});
		return stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.slice(0, 5_000);
	} catch {
		return [];
	}
}

function completionScore(completion: IoCompletionItem, query: string): number | undefined {
	if (!query) return 0;
	const value = completion.value.toLowerCase();
	if (value.startsWith(`/${query.toLowerCase()}`)) return 0;
	if (value.includes(query.toLowerCase())) return 10;
	const description = (completion.description ?? "").toLowerCase();
	if (description.includes(query.toLowerCase())) return 20;
	let cursor = 0;
	for (const char of query.toLowerCase()) {
		cursor = value.indexOf(char, cursor);
		if (cursor === -1) return undefined;
		cursor += 1;
	}
	return 100 + cursor;
}
