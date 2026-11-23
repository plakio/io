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
