import type { IoThemePreference } from "../../config.js";

export interface IoTheme {
	background: string;
	panel: string;
	border: string;
	text: string;
	muted: string;
	accent: string;
	success: string;
	warning: string;
	error: string;
	diffAdd: string;
	diffRemove: string;
}

/**
 * The dark `io` theme: a near-black canvas, a single cool accent and no
 * decorative chrome.
 */
export const ioDarkTheme: IoTheme = {
	background: "#0e0e10",
	panel: "#151518",
	border: "#2a2a30",
	text: "#e6e6e6",
	muted: "#8a8a93",
	accent: "#7aa2f7",
	success: "#9ece6a",
	warning: "#e0af68",
	error: "#f7768e",
	diffAdd: "#9ece6a",
	diffRemove: "#f7768e",
};

export const ioLightTheme: IoTheme = {
	background: "#f7f7f8",
	panel: "#ececef",
	border: "#d0d0d7",
	text: "#1b1b1f",
	muted: "#6d6d78",
	accent: "#3157c8",
	success: "#2f7d32",
	warning: "#9a6700",
	error: "#b42318",
	diffAdd: "#2f7d32",
	diffRemove: "#b42318",
};

export interface ResolvedTheme {
	name: "io" | "io-light";
	mode: "dark" | "light";
	theme: IoTheme;
}

/** Resolve `io`, `io-light`, `system`, `dark` and `light` preferences. */
export function resolveIoTheme(
	preference: IoThemePreference = "io",
	environment: NodeJS.ProcessEnv = process.env,
): ResolvedTheme {
	const systemLight = detectLightSystem(environment);
	const mode =
		preference === "light"
			? "light"
			: preference === "dark"
				? "dark"
				: preference === "io-light"
					? "light"
					: preference === "system"
						? systemLight
							? "light"
							: "dark"
						: "dark";
	return {
		name: mode === "light" ? "io-light" : "io",
		mode,
		theme: mode === "light" ? ioLightTheme : ioDarkTheme,
	};
}

function detectLightSystem(environment: NodeJS.ProcessEnv): boolean {
	if (environment.NO_COLOR) return false;
	const colorFgBg = environment.COLORFGBG;
	if (!colorFgBg) return false;
	const background = Number(colorFgBg.split(";").at(-1));
	return Number.isFinite(background) && background >= 7;
}
