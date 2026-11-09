import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectImageAttachments, mentionPaths, readImageAttachment } from "../src/images.js";

function tempRoot(): string {
	const root = join(tmpdir(), `io-images-${process.pid}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return root;
}

test("mentionPaths extracts @paths in order and dedupes", () => {
	assert.deepEqual(mentionPaths("fix @src/a.png and @b.jpg", "/proj"), ["/proj/src/a.png", "/proj/b.jpg"]);
	assert.deepEqual(mentionPaths("@/abs/x.gif @/abs/x.gif", "/proj"), ["/abs/x.gif"]);
	assert.deepEqual(mentionPaths("no mentions here", "/proj"), []);
	assert.deepEqual(mentionPaths("@", "/proj"), []);
});

test("readImageAttachment reads supported images by extension", () => {
	const root = tempRoot();
	try {
		const png = join(root, "shot.png");
		writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		const attachment = readImageAttachment("shot.png", root);
		assert.equal(attachment?.path, png);
		assert.equal(attachment?.content.type, "image");
		assert.equal(attachment?.content.mimeType, "image/png");
		assert.equal(attachment?.content.data, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"));

		const jpg = join(root, "photo.jpg");
		writeFileSync(jpg, "fakejpeg", "utf8");
		assert.equal(readImageAttachment("photo.jpg", root)?.content.mimeType, "image/jpeg");

		const gif = join(root, "anim.gif");
		writeFileSync(gif, "GIF89a", "utf8");
		assert.equal(readImageAttachment("anim.gif", root)?.content.mimeType, "image/gif");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("readImageAttachment ignores missing, non-image, and oversized files", () => {
	const root = tempRoot();
	try {
		assert.equal(readImageAttachment("missing.png", root), undefined);
		const txt = join(root, "notes.txt");
		writeFileSync(txt, "hello", "utf8");
		assert.equal(readImageAttachment("notes.txt", root), undefined);
		const empty = join(root, "empty.png");
		writeFileSync(empty, Buffer.alloc(0));
		assert.equal(readImageAttachment("empty.png", root), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("collectImageAttachments gathers @images in order", () => {
	const root = tempRoot();
	try {
		writeFileSync(join(root, "a.png"), Buffer.from([1]));
		writeFileSync(join(root, "b.png"), Buffer.from([2]));
		writeFileSync(join(root, "ignore.txt"), "text", "utf8");
		const attachments = collectImageAttachments("see @a.png and @b.png plus @ignore.txt", root);
		assert.deepEqual(
			attachments.map((entry) => entry.path),
			[join(root, "a.png"), join(root, "b.png")],
		);
		assert.deepEqual(collectImageAttachments("no mentions", root), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
