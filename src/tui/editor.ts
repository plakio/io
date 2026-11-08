import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/**
 * Normalize a paste and remove control bytes while preserving every visible
 * character, including all newlines. IO never replaces pasted content with a
 * marker, so the complete text stays reviewable and editable.
 */
export function cleanPastedText(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\x1b[200~")
		.join("")
		.split("\x1b[201~")
		.join("")
		.split("")
		.filter((char) => {
			const code = char.charCodeAt(0);
			return char === "\n" || char === "\t" || (code >= 32 && code !== 127);
		})
		.join("");
}

/**
 * The base editor collapses large pastes into "[paste #1 …]" markers. IO shows
 * the real content instead, as required for reviewing and editing prompts.
 */
export class IoEditor extends Editor {
	constructor(tui: TUI, theme: EditorTheme) {
		super(tui, theme);
		(this as unknown as { handlePaste: (text: string) => void }).handlePaste = (text: string) => {
			const cleaned = cleanPastedText(text);
			if (cleaned.length > 0) this.insertTextAtCursor(cleaned);
		};
	}
}
