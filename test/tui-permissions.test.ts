import assert from "node:assert/strict";
import test from "node:test";
import type { EnginePermissionRequest } from "../src/engine/types.js";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

const request: EnginePermissionRequest = {
	requestID: "per_1",
	sessionID: "ses_1",
	action: "shell",
	resources: ["rm -rf build"],
	message: "Destructive command",
};

test("io shell rules map to OpenCode engine permissions", async () => {
	const { toEnginePermissionRules } = await import("../src/engine/permissions.js");
	assert.deepEqual(
		toEnginePermissionRules([
			{ resource: "rm -rf *", effect: "deny" },
			{ resource: "git status *", effect: "allow" },
			{ resource: "npm publish", effect: "ask" },
		]),
		[
			{ action: "shell", resource: "rm -rf *", effect: "deny" },
			{ action: "shell", resource: "git status *", effect: "allow" },
			{ action: "shell", resource: "npm publish", effect: "ask" },
		],
	);
});

test("io permission sheet defaults to reject and supports feedback", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoPermissionSheet } = await import("../src/tui/next/permission-sheet.js");

	const setup = await createTestRenderer({ width: 110, height: 30 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	const decisions: Array<{ decision: string; message?: string }> = [];
	let closed = 0;
	const sheet = new IoPermissionSheet({
		renderer: setup.renderer,
		shell,
		bell: false,
		onDecision: (decision, message) => {
			decisions.push({ decision, ...(message ? { message } : {}) });
		},
		onClose: () => {
			closed += 1;
		},
	});

	try {
		sheet.open(request);
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Permission required/);
		assert.match(frame, /shell requests access/);
		assert.match(frame, /rm -rf build/);
		assert.match(frame, /Allow once/);
		assert.match(frame, /Always allow/);
		assert.match(frame, /› Reject/);
		assert.equal(sheet.selectedDecision, "reject");

		sheet.move(-1);
		assert.equal(sheet.selectedDecision, "always");
		sheet.move(-1);
		assert.equal(sheet.selectedDecision, "once");
		await sheet.decide("once");
		assert.deepEqual(decisions.at(-1), { decision: "once" });
		assert.equal(closed, 1);

		sheet.open(request);
		assert.equal(sheet.startFeedback(), true);
		sheet.setFeedback("use a narrower path");
		assert.equal(await sheet.commitFeedback(), true);
		assert.deepEqual(decisions.at(-1), { decision: "reject", message: "use a narrower path" });

		sheet.open(request);
		await sheet.decide("reject");
		assert.deepEqual(decisions.at(-1), { decision: "reject" });
		assert.equal(sheet.isOpen, false);
	} finally {
		sheet.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
