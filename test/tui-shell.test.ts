import assert from "node:assert/strict";
import test from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

test("io shell renders the focus layout, tabs, footer and overlays", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { BoxRenderable, TextRenderable } = await import("@opentui/core");
	const { IoShell } = await import("../src/tui/next/shell.js");

	const setup = await createTestRenderer({ width: 120, height: 24 });
	const shell = new IoShell(setup.renderer, {
		cwd: "/home/oscar/project",
		version: "0.2.0",
		branch: "main",
		sessionID: "3f2a",
	});
	try {
		shell.setTabs([
			{ id: "1", label: "build", status: "busy" },
			{ id: "2", label: "explore" },
		]);
		shell.setFooter({
			cwd: "/home/oscar/project",
			branch: "main",
			agent: "Build",
			model: "opencode/deepseek",
			context: "12%",
			tokens: "12.3k in · 1.2k out",
			tps: "38 t/s",
			cost: "$0.01",
		});
		shell.setTranscriptPlaceholder("welcome to io");
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /io/);
		assert.match(frame, /1 build/);
		assert.match(frame, /2 explore/);
		assert.match(frame, /opencode\/deepseek/);
		assert.match(frame, /ctx 12%/);
		assert.match(frame, /38 t\/s/);
		assert.match(frame, /welcome to io/);

		shell.setShowTps(false);
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /38 t\/s/);

		shell.setWidth(80);
		await setup.renderOnce();
		const medium = setup.captureCharFrame();
		assert.match(medium, /ctx 12%/);
		assert.doesNotMatch(medium, /\$0\.01/);

		shell.setTabs([{ id: "1", label: "build" }]);
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /2 explore/);

		shell.toast("saved", "success");
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /saved/);

		const overlay = new BoxRenderable(setup.renderer, {
			border: true,
			borderColor: "#7aa2f7",
			width: 44,
			height: 5,
			alignItems: "center",
			justifyContent: "center",
		});
		overlay.add(new TextRenderable(setup.renderer, { content: "Permission required" }));
		shell.showOverlay(overlay);
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /Permission required/);
		shell.hideOverlay();

		setup.resize(72, 20);
		shell.setWidth(72);
		await setup.renderOnce();
		const compact = setup.captureCharFrame();
		assert.match(compact, /io/);
		assert.doesNotMatch(compact, /\$0\.01/);
	} finally {
		shell.dispose();
		await setup.dispose();
	}
});

test("io shell tabs respond to mouse selection and close buttons", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");

	const setup = await createTestRenderer({ width: 120, height: 24 });
	const selected: string[] = [];
	const closed: string[] = [];
	const shell = new IoShell(setup.renderer, {
		cwd: "/home/oscar/project",
		version: "0.2.2",
		onTabSelect: (id) => selected.push(id),
		onTabClose: (id) => closed.push(id),
	});
	try {
		shell.setTabs(
			[
				{ id: "1", label: "build" },
				{ id: "2", label: "explore" },
				{ id: "3", label: "plan" },
			],
			"1",
		);
		await setup.renderOnce();

		const tab2 = setup.renderer.root.findDescendantById("tab-2");
		assert.ok(tab2);
		await setup.mockMouse.click(tab2.screenX + 1, tab2.screenY);
		assert.deepEqual(selected, ["2"]);

		const close1 = setup.renderer.root.findDescendantById("tab-close-1");
		assert.ok(close1);
		await setup.mockMouse.click(close1.screenX, close1.screenY);
		assert.deepEqual(closed, ["1"]);
	} finally {
		shell.dispose();
		await setup.dispose();
	}
});

test("io shell renders the todo plan and hides it when empty", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");

	const setup = await createTestRenderer({ width: 100, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	try {
		shell.setTodos([
			{ content: "inspect auth flow", status: "completed" },
			{ content: "patch login", status: "in_progress" },
			{ content: "run tests", status: "pending" },
			{ content: "old idea", status: "cancelled" },
		]);
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /plan/);
		assert.match(frame, /\[x\] inspect auth flow/);
		assert.match(frame, /\[~\] patch login/);
		assert.match(frame, /\[ \] run tests/);
		assert.match(frame, /\[-\] old idea/);

		shell.setTodos([]);
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /\[x\] inspect auth flow/);
	} finally {
		shell.dispose();
		await setup.dispose();
	}
});

test("io shell shows an optional sidebar without breaking the transcript", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");

	const setup = await createTestRenderer({ width: 110, height: 24 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.2" });
	try {
		shell.setTranscriptPlaceholder("hello transcript");
		shell.setSidebar(["Session", " Build auth", "", "Plan", " [~] patch login"]);
		assert.equal(shell.isSidebarVisible, false);
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /Build auth/);

		shell.toggleSidebar();
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		assert.match(frame, /hello transcript/);
		assert.match(frame, /Build auth/);
		assert.match(frame, /\[~\] patch login/);

		shell.toggleSidebar();
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /Build auth/);
	} finally {
		shell.dispose();
		await setup.dispose();
	}
});
