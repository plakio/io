import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	BoxRenderable,
	DiffRenderable,
	ScrollBoxRenderable,
	SyntaxStyle,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, ioSyntaxStyles, type IoTheme } from "./theme.js";

const execFileAsync = promisify(execFile);

export type DiffScope = "working" | "branch" | "committed" | "turn";
export type DiffView = "unified" | "split";

export interface DiffFile {
	path: string;
	patch: string;
}

export interface IoDiffViewerOptions {
	renderer: CliRenderer;
	shell: IoShell;
	cwd: string;
	theme?: IoTheme;
	/** Inject for tests or non-git sources. */
	loadDiff?: (scope: DiffScope, cwd: string) => Promise<readonly DiffFile[]>;
	/** Files changed by the active session's last turn. */
	turnDiff?: () => Promise<readonly DiffFile[]>;
	/** Only show files whose path contains this substring. */
	fileFilter?: string;
	onClose?: () => void;
	onError?: (error: unknown) => void;
}

const SCOPES: readonly DiffScope[] = ["working", "branch", "committed", "turn"];

/** Full-screen diff review with a file list, scopes, split/unified and reviewed marks. */
export class IoDiffViewer {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly cwd: string;
	private readonly theme: IoTheme;
	private readonly loadDiff: (scope: DiffScope, cwd: string) => Promise<readonly DiffFile[]>;
	private readonly turnDiff: (() => Promise<readonly DiffFile[]>) | undefined;
	private readonly fileFilter: string | undefined;
	private readonly onClose: (() => void) | undefined;
	private readonly onError: ((error: unknown) => void) | undefined;
	private readonly syntaxStyle: SyntaxStyle;
	private panel: BoxRenderable | undefined;
	private treeBox: BoxRenderable | undefined;
	private tree: ScrollBoxRenderable | undefined;
	private diffBox: BoxRenderable | undefined;
	private diffScroll: ScrollBoxRenderable | undefined;
	private diffRenderable: DiffRenderable | undefined;
	private files: readonly DiffFile[] = [];
	private selected = 0;
	private scope: DiffScope = "working";
	private view: DiffView = "unified";
	private treeVisible = true;
	private opened = false;
	private readonly reviewed = new Set<string>();
	private hunkIndex = 0;
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoDiffViewerOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.cwd = options.cwd;
		this.theme = options.theme ?? ioDarkTheme;
		this.loadDiff = options.loadDiff ?? ((scope, cwd) => loadGitDiffFiles(cwd, scope));
		this.turnDiff = options.turnDiff;
		this.fileFilter = options.fileFilter;
		this.onClose = options.onClose;
		this.onError = options.onError;
		this.syntaxStyle = SyntaxStyle.fromStyles(ioSyntaxStyles(this.theme), options.renderer.nativeScene);
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get currentScope(): DiffScope {
		return this.scope;
	}

	get currentView(): DiffView {
		return this.view;
	}

	get selectedFile(): DiffFile | undefined {
		return this.files[this.selected];
	}

	get isTreeVisible(): boolean {
		return this.treeVisible;
	}

	get reviewedFiles(): readonly string[] {
		return [...this.reviewed];
	}

	async open(scope: DiffScope = "working"): Promise<void> {
		if (this.opened) this.close();
		this.scope = scope;
		this.opened = true;
		this.panel = this.buildPanel();
		this.shell.showOverlay(this.panel);
		this.renderer.keyInput.on("keypress", this.keyHandler);
		await this.reload();
	}

	close(): void {
		if (!this.opened) return;
		this.opened = false;
		this.renderer.keyInput.off("keypress", this.keyHandler);
		this.panel = undefined;
		this.treeBox = undefined;
		this.tree = undefined;
		this.diffBox = undefined;
		this.diffScroll = undefined;
		this.diffRenderable = undefined;
		this.shell.hideOverlay();
		this.onClose?.();
		this.renderer.requestRender();
	}

	setFiles(files: readonly DiffFile[], scope?: DiffScope): void {
		if (scope) this.scope = scope;
		this.files = files;
		this.selected = 0;
		this.hunkIndex = 0;
		this.rebuild();
	}

	selectFile(delta: number): boolean {
		if (this.files.length === 0) return false;
		this.selected = (this.selected + delta + this.files.length) % this.files.length;
		this.hunkIndex = 0;
		this.renderSelected();
		this.renderTree();
		return true;
	}

	nextHunk(delta: number): boolean {
		const diff = this.diffRenderable;
		if (!diff) return false;
		const offsets = diff.getHunkRowOffsets();
		if (offsets.length === 0) return false;
		this.hunkIndex = (this.hunkIndex + delta + offsets.length) % offsets.length;
		this.diffScroll?.scrollTo(offsets[this.hunkIndex] ?? 0);
		return true;
	}

	toggleView(): boolean {
		if (!this.diffRenderable) return false;
		this.view = this.view === "unified" ? "split" : "unified";
		this.renderSelected();
		return true;
	}

	toggleTree(): void {
		this.treeVisible = !this.treeVisible;
		if (this.treeBox) this.treeBox.visible = this.treeVisible;
		this.renderer.requestRender();
	}

	markReviewed(): boolean {
		const file = this.selectedFile;
		if (!file) return false;
		if (this.reviewed.has(file.path)) this.reviewed.delete(file.path);
		else this.reviewed.add(file.path);
		this.renderTree();
		return true;
	}

	async cycleScope(): Promise<DiffScope> {
		const index = SCOPES.indexOf(this.scope);
		this.scope = SCOPES[(index + 1) % SCOPES.length] ?? "working";
		await this.reload();
		return this.scope;
	}

	dispose(): void {
		this.close();
		this.syntaxStyle.destroy();
	}

	private async reload(): Promise<void> {
		try {
			const files = this.scope === "turn" && this.turnDiff
				? await this.turnDiff()
				: await this.loadDiff(this.scope, this.cwd);
			this.files = this.fileFilter
				? files.filter((file) => file.path.includes(this.fileFilter!))
				: files;
			this.selected = 0;
			this.hunkIndex = 0;
			this.rebuild();
		} catch (error) {
			this.onError?.(error);
			this.files = [];
			this.rebuild(String((error as Error).message ?? error));
		}
	}

	private rebuild(error?: string): void {
		if (!this.tree || !this.diffBox || !this.panel) return;
		this.panel.title = `Diff · ${this.scope} · ${this.view}`;
		clearChildren(this.tree);
		if (this.files.length === 0) {
			this.tree.add(
				new TextRenderable(this.renderer, {
					content: error ?? "No changes",
					fg: this.theme.muted,
					bg: this.theme.panel,
					wrapMode: "word",
				}),
			);
			clearChildren(this.diffBox);
			this.diffScroll = undefined;
			this.diffRenderable = undefined;
			return;
		}
		this.renderTree();
		this.renderSelected();
	}

	private renderTree(): void {
		if (!this.tree) return;
		clearChildren(this.tree);
		this.files.forEach((file, index) => {
			const selected = index === this.selected;
			const reviewed = this.reviewed.has(file.path) ? "✓" : " ";
			this.tree?.add(
				new TextRenderable(this.renderer, {
					content: `${selected ? "›" : " "} ${reviewed} ${file.path}`,
					fg: selected ? this.theme.accent : this.theme.text,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
					truncate: true,
				}),
			);
		});
	}

	private renderSelected(): void {
		if (!this.diffBox) return;
		const file = this.selectedFile;
		clearChildren(this.diffBox);
		if (!file) return;
		const header = new TextRenderable(this.renderer, {
			content: file.path,
			fg: this.theme.accent,
			bg: this.theme.panel,
			height: 1,
			wrapMode: "none",
			truncate: true,
		});
		this.diffBox.add(header);
		this.diffScroll = new ScrollBoxRenderable(this.renderer, {
			flexGrow: 1,
			flexShrink: 1,
			scrollY: true,
			backgroundColor: this.theme.panel,
		});
		this.diffRenderable = new DiffRenderable(this.renderer, {
			diff: file.patch,
			view: this.view,
			filetype: file.path.split(".").pop(),
			syntaxStyle: this.syntaxStyle,
			width: "100%",
			flexShrink: 0,
			showLineNumbers: true,
			wrapMode: this.view === "split" ? "none" : "word",
		});
		this.diffScroll.add(this.diffRenderable);
		this.diffBox.add(this.diffScroll);
		this.renderer.requestRender();
	}

	private buildPanel(): BoxRenderable {
		const panel = new BoxRenderable(this.renderer, {
			width: "92%",
			maxWidth: 130,
			height: "86%",
			maxHeight: 38,
			border: true,
			borderColor: this.theme.border,
			title: `Diff · ${this.scope} · ${this.view}`,
			titleColor: this.theme.accent,
			backgroundColor: this.theme.panel,
			padding: 1,
			flexDirection: "column",
			gap: 1,
		});
		const body = new BoxRenderable(this.renderer, {
			flexGrow: 1,
			flexShrink: 1,
			flexDirection: "row",
			gap: 1,
			backgroundColor: this.theme.panel,
		});
		const treeBox = new BoxRenderable(this.renderer, {
			width: 30,
			flexShrink: 0,
			border: ["right"],
			borderColor: this.theme.border,
			paddingX: 1,
			backgroundColor: this.theme.panel,
		});
		const tree = new ScrollBoxRenderable(this.renderer, {
			flexGrow: 1,
			flexShrink: 1,
			scrollY: true,
			backgroundColor: this.theme.panel,
		});
		treeBox.add(tree);
		const diffBox = new BoxRenderable(this.renderer, {
			flexGrow: 1,
			flexShrink: 1,
			flexDirection: "column",
			backgroundColor: this.theme.panel,
		});
		body.add(treeBox);
		body.add(diffBox);
		panel.add(body);
		panel.add(
			new TextRenderable(this.renderer, {
				content: "n/p file · ]/[ hunk · v split · b tree · d scope · m reviewed · esc close",
				fg: this.theme.muted,
				bg: this.theme.panel,
				height: 1,
				wrapMode: "none",
				truncate: true,
			}),
		);
		this.treeBox = treeBox;
		this.tree = tree;
		this.diffBox = diffBox;
		this.diffScroll = undefined;
		this.diffRenderable = undefined;
		return panel;
	}

	private handleKey(event: IoKeyEvent): void {
		if (!this.opened || event.defaultPrevented) return;
		const name = event.name.toLowerCase();
		if (name === "escape" || name === "q") this.close();
		else if (name === "n") this.selectFile(1);
		else if (name === "p") this.selectFile(-1);
		else if (name === "]") this.nextHunk(1);
		else if (name === "[") this.nextHunk(-1);
		else if (name === "v") this.toggleView();
		else if (name === "b") this.toggleTree();
		else if (name === "d") void this.cycleScope();
		else if (name === "m") this.markReviewed();
		else return;
		event.preventDefault?.();
		event.stopPropagation?.();
	}
}

export async function loadGitDiffFiles(cwd: string, scope: DiffScope): Promise<readonly DiffFile[]> {
	const run = async (args: string[]) => {
		const result = await execFileAsync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
			timeout: 20_000,
		});
		return result.stdout;
	};
	let patch = "";
	if (scope === "committed") {
		patch = await run(["show", "--format=", "--no-color", "HEAD"]);
	} else if (scope === "branch") {
		let base = "HEAD~1";
		try {
			base = (await run(["merge-base", "HEAD", "@{upstream}"])).trim() || "HEAD~1";
		} catch {
			// No upstream: compare with the previous commit.
		}
		try {
			patch = await run(["diff", "--no-color", `${base}..HEAD`]);
		} catch {
			patch = await run(["diff", "--no-color", "HEAD"]);
		}
	} else {
		try {
			patch = await run(["diff", "--no-color", "HEAD"]);
		} catch {
			patch = await run(["diff", "--no-color"]);
		}
	}
	return splitPatch(patch);
}

export function splitPatch(patch: string): readonly DiffFile[] {
	const normalized = patch.replace(/\r\n/g, "\n");
	const chunks = normalized.split(/^(?=diff --git )/m).filter((chunk) => chunk.trim().length > 0);
	return chunks.map((chunk) => ({
		path: filePath(chunk),
		patch: chunk.trimEnd(),
	}));
}

function filePath(chunk: string): string {
	const match = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
	if (match?.[2]) return match[2];
	const plus = /^\+\+\+ b\/(.+)$/m.exec(chunk);
	return plus?.[1] ?? "(unknown file)";
}

function clearChildren(container: { getChildren(): readonly { destroyRecursively(): void }[]; remove(child: never): void }): void {
	for (const child of [...container.getChildren()]) {
		container.remove(child as never);
		child.destroyRecursively();
	}
}
