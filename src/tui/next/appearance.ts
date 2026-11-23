import type {
	IoAppearanceConfig,
	IoAppearanceVerbosity,
	IoThemePreference,
} from "../../config.js";
import type { IoShell } from "./shell.js";
import type { IoTranscript } from "./transcript.js";
import { resolveIoTheme, type IoTheme, type ResolvedTheme } from "./theme.js";

export type IoVerbosity = IoAppearanceVerbosity;

export interface IoAppearanceDefaults {
	thinking: boolean;
	tps: boolean;
	markdown: "rendered" | "source";
	toolOutput: "collapsed" | "expanded";
}

export const VERBOSITY_ORDER: readonly IoVerbosity[] = ["low", "normal", "high", "debug"];

/** Resolved appearance state applied to the shell and transcript. */
export class IoAppearance {
	private readonly environment: NodeJS.ProcessEnv;
	private verbosityValue: IoVerbosity;
	private thinkingValue: boolean;
	private tpsValue: boolean;
	private markdownValue: "rendered" | "source";
	private toolOutputValue: "collapsed" | "expanded";
	private themePreferenceValue: IoThemePreference;

	constructor(config: IoAppearanceConfig = {}, environment: NodeJS.ProcessEnv = process.env) {
		this.environment = environment;
		this.verbosityValue = config.verbosity ?? "normal";
		const defaults = defaultsFor(this.verbosityValue);
		this.thinkingValue = config.thinking ?? defaults.thinking;
		this.tpsValue = config.tps ?? defaults.tps;
		this.markdownValue = config.markdown ?? defaults.markdown;
		this.toolOutputValue = config.toolOutput ?? defaults.toolOutput;
		this.themePreferenceValue = config.theme ?? "io";
	}

	get verbosity(): IoVerbosity {
		return this.verbosityValue;
	}

	get thinking(): boolean {
		return this.thinkingValue;
	}

	get tps(): boolean {
		return this.tpsValue;
	}

	get markdown(): "rendered" | "source" {
		return this.markdownValue;
	}

	get toolOutput(): "collapsed" | "expanded" {
		return this.toolOutputValue;
	}

	get themePreference(): IoThemePreference {
		return this.themePreferenceValue;
	}

	get resolvedTheme(): ResolvedTheme {
		return resolveIoTheme(this.themePreferenceValue, this.environment);
	}

	get theme(): IoTheme {
		return this.resolvedTheme.theme;
	}

	setVerbosity(verbosity: IoVerbosity): void {
		this.verbosityValue = verbosity;
		const defaults = defaultsFor(verbosity);
		this.thinkingValue = defaults.thinking;
		this.tpsValue = defaults.tps;
		this.markdownValue = defaults.markdown;
		this.toolOutputValue = defaults.toolOutput;
	}

	cycleVerbosity(): IoVerbosity {
		const index = VERBOSITY_ORDER.indexOf(this.verbosityValue);
		this.setVerbosity(VERBOSITY_ORDER[(index + 1) % VERBOSITY_ORDER.length] ?? "normal");
		return this.verbosityValue;
	}

	setThinking(thinking: boolean): void {
		this.thinkingValue = thinking;
	}

	setTps(tps: boolean): void {
		this.tpsValue = tps;
	}

	setMarkdown(markdown: "rendered" | "source"): void {
		this.markdownValue = markdown;
	}

	setToolOutput(toolOutput: "collapsed" | "expanded"): void {
		this.toolOutputValue = toolOutput;
	}

	setTheme(theme: IoThemePreference): void {
		this.themePreferenceValue = theme;
	}

	applyToShell(shell: IoShell): void {
		shell.setTheme(this.theme);
		shell.setShowTps(this.tps);
	}

	applyToTranscript(transcript: IoTranscript): void {
		transcript.setShowThinking(this.thinking);
		transcript.setToolOutputExpanded(this.toolOutput === "expanded");
		transcript.setMarkdown(this.markdown === "rendered");
	}

	toConfig(): IoAppearanceConfig {
		return {
			theme: this.themePreferenceValue,
			verbosity: this.verbosityValue,
			thinking: this.thinkingValue,
			tps: this.tpsValue,
			markdown: this.markdownValue,
			toolOutput: this.toolOutputValue,
		};
	}
}

export function defaultsFor(verbosity: IoVerbosity): IoAppearanceDefaults {
	if (verbosity === "low") {
		return { thinking: false, tps: false, markdown: "rendered", toolOutput: "collapsed" };
	}
	if (verbosity === "high") {
		return { thinking: true, tps: true, markdown: "rendered", toolOutput: "expanded" };
	}
	if (verbosity === "debug") {
		return { thinking: true, tps: true, markdown: "source", toolOutput: "expanded" };
	}
	return { thinking: false, tps: true, markdown: "rendered", toolOutput: "collapsed" };
}
