import assert from "node:assert/strict";
import test from "node:test";
import type { EngineForm, EngineFormValue } from "../src/engine/types.js";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

const form: EngineForm = {
	id: "form_1",
	sessionID: "ses_1",
	title: "Deployment",
	fields: [
		{ key: "name", title: "Name", type: "string", required: true },
		{ key: "subscribe", title: "Subscribe", type: "boolean", default: false },
		{
			key: "color",
			title: "Color",
			type: "string",
			options: [
				{ value: "red", label: "Red" },
				{ value: "blue", label: "Blue" },
			],
		},
		{
			key: "tags",
			title: "Tags",
			type: "multiselect",
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
		},
		{ key: "count", title: "Count", type: "integer" },
	],
};

test("io form sheet collects text, boolean, select and multiselect answers", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoFormSheet } = await import("../src/tui/next/form-sheet.js");

	const setup = await createTestRenderer({ width: 110, height: 32 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	let answer: Record<string, EngineFormValue> | undefined;
	let closed = 0;
	const sheet = new IoFormSheet({
		renderer: setup.renderer,
		shell,
		form,
		onReply: (_form, values) => {
			answer = values;
		},
		onCancel: () => undefined,
		onClose: () => {
			closed += 1;
		},
	});

	try {
		sheet.open();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Deployment/);
		assert.match(frame, /Name \*/);
		assert.match(frame, /Subscribe/);

		sheet.setText("Ada");
		assert.equal(sheet.advance(), true);
		sheet.toggle();
		assert.equal(sheet.advance(), true);
		sheet.moveOption(1);
		assert.equal(sheet.advance(), true);
		sheet.toggle();
		sheet.moveOption(1);
		sheet.toggle();
		assert.equal(sheet.advance(), true);
		sheet.setText("3");
		assert.equal(sheet.advance(), true);

		assert.deepEqual(answer, {
			name: "Ada",
			subscribe: true,
			color: "blue",
			tags: ["a", "b"],
			count: 3,
		});
		assert.equal(sheet.isOpen, false);
		assert.equal(closed, 1);
	} finally {
		sheet.dispose();
		shell.dispose();
		await setup.dispose();
	}
});

test("io form sheet enforces required fields and cancellation", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoFormSheet } = await import("../src/tui/next/form-sheet.js");

	const setup = await createTestRenderer({ width: 100, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	let cancelled = false;
	let replied = false;
	const sheet = new IoFormSheet({
		renderer: setup.renderer,
		shell,
		form,
		onReply: () => {
			replied = true;
		},
		onCancel: () => {
			cancelled = true;
		},
	});
	try {
		sheet.open();
		assert.equal(sheet.advance(), false);
		assert.equal(replied, false);
		sheet.cancel();
		assert.equal(cancelled, true);
		assert.equal(sheet.isOpen, false);
	} finally {
		sheet.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
