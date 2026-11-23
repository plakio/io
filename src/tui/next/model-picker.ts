import {
	BoxRenderable,
	InputRenderable,
	ScrollBoxRenderable,
	TextRenderable,
	type CliRenderer,
} from "@opentui/core";
import type { EngineModel, EngineModelRef } from "../../engine/types.js";
import type { IoKeyEvent } from "./keymap.js";
import type { IoShell } from "./shell.js";
import { ioDarkTheme, type IoTheme } from "./theme.js";

export interface IoModelPickerOptions {
	renderer: CliRenderer;
	shell: IoShell;
	models: readonly EngineModel[];
	current?: EngineModelRef;
	favorites?: readonly string[];
	recent?: readonly string[];
	theme?: IoTheme;
	onSelect: (model: EngineModel, variant?: string) => void | Promise<void>;
	onFavoriteChange?: (model: string, favorite: boolean) => void;
	onClose?: () => void;
	onError?: (error: unknown) => void;
}

/** Model catalog grouped by provider, with search, favorites, recent and variants. */
export class IoModelPicker {
	private readonly renderer: CliRenderer;
	private readonly shell: IoShell;
	private readonly theme: IoTheme;
	private readonly callbacks: Pick<IoModelPickerOptions, "onSelect" | "onFavoriteChange" | "onClose" | "onError">;
	private models: readonly EngineModel[];
	private current: EngineModelRef | undefined;
	private favorites: Set<string>;
	private recent: string[];
	private panel: BoxRenderable | undefined;
	private input: InputRenderable | undefined;
	private list: ScrollBoxRenderable | undefined;
	private visible: readonly EngineModel[] = [];
	private selected = 0;
	private opened = false;
	private readonly variants = new Map<string, string>();
	private readonly keyHandler: (event: IoKeyEvent) => void;

	constructor(options: IoModelPickerOptions) {
		this.renderer = options.renderer;
		this.shell = options.shell;
		this.theme = options.theme ?? ioDarkTheme;
		this.models = options.models;
		this.current = options.current;
		this.favorites = new Set(options.favorites ?? []);
		this.recent = [...(options.recent ?? [])];
		this.callbacks = options;
		if (options.current?.variant) this.variants.set(modelKey(options.current), options.current.variant);
		this.keyHandler = (event) => this.handleKey(event);
	}

	get isOpen(): boolean {
		return this.opened;
	}

	get selectedModel(): EngineModel | undefined {
		return this.visible[this.selected];
	}

	get selectedVariant(): string | undefined {
		const model = this.selectedModel;
		if (!model) return undefined;
		return this.variants.get(modelKey(model)) ?? model.variants[0];
	}

	open(): void {
		if (this.opened) return;
		this.opened = true;
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
		this.renderer.keyInput.off("keypress", this.keyHandler);
		this.input = undefined;
		this.list = undefined;
		this.panel = undefined;
		this.shell.hideOverlay();
		this.callbacks.onClose?.();
		this.renderer.requestRender();
	}

	setModels(models: readonly EngineModel[]): void {
		this.models = models;
		this.refresh();
	}

	setCurrent(current: EngineModelRef | undefined): void {
		this.current = current;
		if (current?.variant) this.variants.set(modelKey(current), current.variant);
		this.refresh();
	}

	setFavorites(favorites: readonly string[]): void {
		this.favorites = new Set(favorites);
		this.refresh();
	}

	setRecent(recent: readonly string[]): void {
		this.recent = [...recent];
		this.refresh();
	}

	setQuery(query: string): void {
		if (!this.input) return;
		this.input.value = query;
		this.refresh();
	}

	move(delta: number): void {
		if (this.visible.length === 0) return;
		this.selected = (this.selected + delta + this.visible.length) % this.visible.length;
		this.refresh();
	}

	nextProvider(): boolean {
		if (this.visible.length === 0) return false;
		const current = this.selectedModel;
		if (!current) return false;
		const providers = [...new Set(this.visible.map((model) => model.provider))];
		const index = providers.indexOf(current.provider);
		const next = providers[(index + 1) % providers.length];
		const target = this.visible.findIndex((model) => model.provider === next);
		if (target < 0) return false;
		this.selected = target;
		this.refresh();
		return true;
	}

	cycleVariant(): boolean {
		const model = this.selectedModel;
		if (!model || model.variants.length === 0) return false;
		const current = this.variants.get(modelKey(model)) ?? model.variants[0];
		const index = Math.max(0, model.variants.indexOf(current ?? ""));
		const next = model.variants[(index + 1) % model.variants.length];
		if (next) this.variants.set(modelKey(model), next);
		this.refresh();
		return true;
	}

	toggleFavorite(): boolean {
		const model = this.selectedModel;
		if (!model) return false;
		const key = modelKey(model);
		const favorite = !this.favorites.has(key);
		if (favorite) this.favorites.add(key);
		else this.favorites.delete(key);
		this.callbacks.onFavoriteChange?.(key, favorite);
		this.refresh();
		return true;
	}

	selectCurrent(): boolean {
		const model = this.selectedModel;
		if (!model) return false;
		const key = modelKey(model);
		this.recent = [key, ...this.recent.filter((entry) => entry !== key)].slice(0, 10);
		const variant = this.selectedVariant;
		this.close();
		void Promise.resolve(this.callbacks.onSelect(model, variant)).catch((error) => this.callbacks.onError?.(error));
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
		else if (event.ctrl && name === "t") this.cycleVariant();
		else if (event.ctrl && name === "a") this.nextProvider();
		else if (event.ctrl && name === "f") this.toggleFavorite();
		else return;
		event.preventDefault?.();
		event.stopPropagation?.();
	}

	private buildPanel(): BoxRenderable {
		const panel = new BoxRenderable(this.renderer, {
			width: "82%",
			maxWidth: 96,
			height: "66%",
			maxHeight: 26,
			border: true,
			borderColor: this.theme.border,
			title: "Models",
			titleColor: this.theme.accent,
			backgroundColor: this.theme.panel,
			padding: 1,
			flexDirection: "column",
			gap: 1,
		});
		const input = new InputRenderable(this.renderer, {
			value: "",
			placeholder: "Search models…",
			textColor: this.theme.text,
			backgroundColor: this.theme.panel,
			focusedBackgroundColor: this.theme.panel,
			focusedTextColor: this.theme.text,
			placeholderColor: this.theme.muted,
		});
		input.onContentChange = () => this.refresh();
		const list = new ScrollBoxRenderable(this.renderer, {
			flexGrow: 1,
			flexShrink: 1,
			scrollY: true,
			backgroundColor: this.theme.panel,
			paddingX: 1,
		});
		const hint = new TextRenderable(this.renderer, {
			content: "↑↓ move · enter select · ctrl+t variant · ctrl+a provider · ctrl+f favorite",
			fg: this.theme.muted,
			bg: this.theme.panel,
			height: 1,
			wrapMode: "none",
			truncate: true,
		});
		panel.add(input);
		panel.add(list);
		panel.add(hint);
		this.input = input;
		this.list = list;
		return panel;
	}

	private refresh(): void {
		if (!this.list || !this.input) return;
		const query = this.input.value.trim().toLowerCase();
		const matching = this.models.filter((model) =>
			`${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(query),
		);
		const recentModels = query
			? []
			: this.recent
					.map((key) => matching.find((model) => modelKey(model) === key))
					.filter((model): model is EngineModel => model !== undefined);
		const recentKeys = new Set(recentModels.map(modelKey));
		const grouped = matching.filter((model) => !recentKeys.has(modelKey(model)));

		const entries: Array<{ header: string } | { model: EngineModel; index: number }> = [];
		let modelIndex = 0;
		if (recentModels.length > 0) {
			entries.push({ header: "Recent" });
			for (const model of recentModels) {
				entries.push({ model, index: modelIndex++ });
			}
		}
		let provider = "";
		for (const model of grouped) {
			if (model.provider !== provider) {
				provider = model.provider;
				entries.push({ header: provider });
			}
			entries.push({ model, index: modelIndex++ });
		}
		this.visible = entries
			.filter((entry): entry is { model: EngineModel; index: number } => "model" in entry)
			.map((entry) => entry.model);
		this.selected = Math.min(this.selected, Math.max(0, this.visible.length - 1));

		clearChildren(this.list);
		if (this.visible.length === 0) {
			this.list.add(
				new TextRenderable(this.renderer, {
					content: "No models",
					fg: this.theme.muted,
					bg: this.theme.panel,
					height: 1,
					wrapMode: "none",
				}),
			);
		} else {
			for (const entry of entries) {
				if ("header" in entry) {
					this.list.add(
						new TextRenderable(this.renderer, {
							content: entry.header,
							fg: this.theme.accent,
							bg: this.theme.panel,
							height: 1,
							wrapMode: "none",
						}),
					);
					continue;
				}
				const { model, index } = entry;
				const key = modelKey(model);
				const selected = index === this.selected;
				const current = this.current && key === modelKey(this.current) ? "●" : " ";
				const favorite = this.favorites.has(key) ? "★" : " ";
				const variant = model.variants.length > 0 ? this.variants.get(key) ?? model.variants[0] : "—";
				const cost = model.cost ? `$${formatCost(model.cost.input)}/$${formatCost(model.cost.output)}` : "—";
				this.list.add(
					new TextRenderable(this.renderer, {
						content: `${selected ? "›" : " "} ${favorite} ${current} ${model.name}  ctx ${formatContext(model.contextWindow)}  ${variant}  ${cost}`,
						fg: selected ? this.theme.accent : this.theme.text,
						bg: this.theme.panel,
						height: 1,
						wrapMode: "none",
						truncate: true,
					}),
				);
			}
		}
		try {
			this.list.scrollTo(0);
		} catch {
			// Layout may not be ready during the first refresh.
		}
		this.renderer.requestRender();
	}
}

function modelKey(model: EngineModelRef): string {
	return `${model.provider}/${model.id}`;
}

function formatContext(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

function formatCost(value: number): string {
	return value.toFixed(2);
}

function clearChildren(container: { getChildren(): readonly { destroyRecursively(): void }[]; remove(child: never): void }): void {
	for (const child of [...container.getChildren()]) {
		container.remove(child as never);
		child.destroyRecursively();
	}
}
