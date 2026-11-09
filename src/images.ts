import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";

/** Extension → mime for inline image attachments. */
const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

/** Skip attachments larger than this (keeps prompts and session files sane). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ImageAttachment {
	path: string;
	content: ImageContent;
}

/** `@path` mention in prompt text, not followed by whitespace. */
const MENTION_REGEX = /@([^\s]+)/g;

/** Resolve `@path` mentions to absolute paths, deduped, in first-seen order. */
export function mentionPaths(text: string, cwd: string): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const match of text.matchAll(MENTION_REGEX)) {
		const raw = match[1];
		if (!raw) continue;
		const absolute = isAbsolute(raw) ? raw : join(cwd, raw);
		if (seen.has(absolute)) continue;
		seen.add(absolute);
		paths.push(absolute);
	}
	return paths;
}

/**
 * Read an image attachment for an `@path` mention (or absolute path).
 * Returns undefined when the file is missing, not a regular file, unsupported
 * type, or over the size cap — the mention then just stays plain text.
 */
export function readImageAttachment(candidate: string, cwd: string): ImageAttachment | undefined {
	const absolute = isAbsolute(candidate) ? candidate : join(cwd, candidate);
	const mimeType = IMAGE_MIME[extname(absolute).toLowerCase()];
	if (!mimeType) return undefined;
	try {
		if (!existsSync(absolute)) return undefined;
		const stat = statSync(absolute);
		if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) return undefined;
		const data = readFileSync(absolute).toString("base64");
		return { path: absolute, content: { type: "image", data, mimeType } };
	} catch {
		return undefined;
	}
}

/** Attachments for every `@image` mention in the text, in order. */
export function collectImageAttachments(text: string, cwd: string): ImageAttachment[] {
	if (!text.includes("@")) return [];
	const attachments: ImageAttachment[] = [];
	const seen = new Set<string>();
	for (const path of mentionPaths(text, cwd)) {
		if (seen.has(path)) continue;
		seen.add(path);
		const attachment = readImageAttachment(path, cwd);
		if (attachment) attachments.push(attachment);
	}
	return attachments;
}
