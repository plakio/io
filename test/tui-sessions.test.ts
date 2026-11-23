import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEngine, EngineSessionSummary } from "../src/engine/types.js";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

function session(id: string, title: string, updatedAt = Date.now()): EngineSessionSummary {
	return { id, title, createdAt: updatedAt, updatedAt };
}

test("io session tabs show root sessions and hide a single tab", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoSessionTabs } = await import("../src/tui/next/session-tabs.js");

	const setup = await createTestRenderer({ width: 100, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	const engine = { listSessions: async () => [] } as unknown as AgentEngine;
	const tabs = new IoSessionTabs(shell, engine);

	try {
		tabs.setSessions([session("ses_a", "Build auth"), session("ses_b", "Explore tests")], "ses_a");
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Build auth/);
		assert.match(frame, /Explore tests/);

		const next = tabs.closeSlot(2);
		assert.equal(next?.id, "ses_a");
		assert.deepEqual(tabs.current.map((entry) => entry.id), ["ses_a"]);
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /Explore tests/);

		tabs.setSessions([session("ses_a", "Build auth")], "ses_a");
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /Explore tests/);
	} finally {
		shell.dispose();
		await setup.dispose();
	}
});

test("io session switcher filters, resumes, renames, deletes and forks", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoSessionSwitcher } = await import("../src/tui/next/session-switcher.js");

	const setup = await createTestRenderer({ width: 100, height: 30 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	const events: string[] = [];
	let selected: string | undefined;
	const switcher = new IoSessionSwitcher({
		renderer: setup.renderer,
		shell,
		sessions: [session("ses_alpha", "Build auth"), session("ses_beta", "Explore tests")],
		activeID: "ses_alpha",
		onSelect: (entry) => {
			selected = entry.id;
			events.push(`select:${entry.id}`);
		},
		onRename: (entry, title) => {
			events.push(`rename:${entry.id}:${title}`);
		},
		onDelete: (entry) => {
			events.push(`delete:${entry.id}`);
		},
		onFork: (entry) => {
			events.push(`fork:${entry.id}`);
		},
	});

	try {
		switcher.open();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /Sessions/);
		assert.match(frame, /Build auth/);
		assert.match(frame, /Explore tests/);

		switcher.setQuery("beta");
		assert.equal(switcher.selectedSession?.id, "ses_beta");
		assert.equal(switcher.selectCurrent(), true);
		assert.equal(selected, "ses_beta");
		assert.equal(switcher.isOpen, false);

		switcher.open();
		switcher.setQuery("alpha");
		assert.equal(switcher.startRename(), true);
		assert.equal(await switcher.commitRename("Renamed auth"), true);
		assert.equal(switcher.selectedSession?.title, "Renamed auth");
		assert.equal(await switcher.deleteSelected(), true);
		switcher.setQuery("beta");
		assert.equal(switcher.selectedSession?.id, "ses_beta");
		assert.equal(await switcher.forkSelected(), true);
		assert.deepEqual(events.filter((event) => event.startsWith("rename:")), [
			"rename:ses_alpha:Renamed auth",
		]);
		assert.ok(events.some((event) => event.startsWith("delete:")));
		assert.ok(events.some((event) => event.startsWith("fork:ses_beta")));
	} finally {
		switcher.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
