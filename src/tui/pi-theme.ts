import { getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme } from "@earendil-works/pi-tui";

let initialized = false;

/**
 * Initialize Pi's global theme before any of its components render. Pi's
 * components read the active theme through a module-level proxy, so this has
 * to happen before the first `new UserMessageComponent(...)`.
 */
export function initPiVisuals(): void {
	if (initialized) return;
	initTheme(process.env.IO_PI_THEME ?? "dark");
	initialized = true;
}

/** Pi's editor border/selection colors, derived from its exported theme views. */
export function piEditorTheme(): EditorTheme {
	const selectList = getSelectListTheme();
	return {
		borderColor: selectList.description,
		selectList,
	};
}

/** Accent color used by Pi's spinners and selected rows. */
export function piAccent(text: string): string {
	return getSelectListTheme().selectedText(text);
}

/** Muted color used by Pi's secondary text. */
export function piMuted(text: string): string {
	return getSelectListTheme().description(text);
}
