import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

function wrap(open: string, close: string): (text: string) => string {
	return (text: string) => `${open}${text}${close}`;
}

export const style = {
	bold: wrap("\x1b[1m", "\x1b[22m"),
	dim: wrap("\x1b[2m", "\x1b[22m"),
	italic: wrap("\x1b[3m", "\x1b[23m"),
	underline: wrap("\x1b[4m", "\x1b[24m"),
	reverse: wrap("\x1b[7m", "\x1b[27m"),
	strikethrough: wrap("\x1b[9m", "\x1b[29m"),
};

export const markdownTheme: MarkdownTheme = {
	heading: style.bold,
	link: style.underline,
	linkUrl: style.dim,
	code: style.dim,
	codeBlock: (text) => text,
	codeBlockBorder: style.dim,
	quote: style.dim,
	quoteBorder: style.dim,
	hr: style.dim,
	listBullet: style.dim,
	bold: style.bold,
	italic: style.italic,
	strikethrough: style.strikethrough,
	underline: style.underline,
	codeBlockIndent: "  ",
};

export const selectListTheme: SelectListTheme = {
	selectedPrefix: style.bold,
	selectedText: style.bold,
	description: style.dim,
	scrollInfo: style.dim,
	noMatch: style.dim,
};

export const editorTheme: EditorTheme = {
	borderColor: style.dim,
	selectList: selectListTheme,
};
