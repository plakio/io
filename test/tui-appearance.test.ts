import assert from "node:assert/strict";
import test from "node:test";

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = Boolean(process.versions.bun) || (major ?? 0) > 26 || ((major ?? 0) === 26 && (minor ?? 0) >= 4);

test("io appearance resolves themes, defaults and config round-trip", async () => {
	const { IoAppearance, defaultsFor } = await import("../src/tui/next/appearance.js");
	const { ioDarkTheme, ioLightTheme, resolveIoTheme } = await import("../src/tui/next/theme.js");
	const { parseConfig } = await import("../src/config.js");

	assert.equal(resolveIoTheme("io").name, "io");
	assert.equal(resolveIoTheme("io-light").name, "io-light");
	assert.equal(resolveIoTheme("dark").mode, "dark");
	assert.equal(resolveIoTheme("light").mode, "light");
	assert.equal(resolveIoTheme("system", { COLORFGBG: "0;15" }).mode, "light");
	assert.equal(resolveIoTheme("system", { COLORFGBG: "15;0" }).mode, "dark");

	assert.deepEqual(defaultsFor("low"), {
		thinking: false,
		tps: false,
		markdown: "rendered",
		toolOutput: "collapsed",
	});
	assert.deepEqual(defaultsFor("high"), {
		thinking: true,
		tps: true,
		markdown: "rendered",
		toolOutput: "expanded",
	});
	assert.equal(defaultsFor("debug").markdown, "source");

	const appearance = new IoAppearance({
		theme: "io-light",
		verbosity: "debug",
		tps: false,
	});
	assert.equal(appearance.theme.background, ioLightTheme.background);
	assert.equal(appearance.markdown, "source");
	assert.equal(appearance.thinking, true);
	assert.equal(appearance.tps, false);
	assert.equal(appearance.toolOutput, "expanded");
	appearance.setVerbosity("low");
	assert.equal(appearance.thinking, false);
	assert.equal(appearance.tps, false);
	assert.equal(appearance.toolOutput, "collapsed");
	assert.equal(appearance.cycleVerbosity(), "normal");
	assert.equal(appearance.cycleVerbosity(), "high");
	assert.equal(appearance.cycleVerbosity(), "debug");
	assert.equal(appearance.cycleVerbosity(), "low");
	assert.equal(appearance.toConfig().theme, "io-light");

	const parsed = parseConfig({
		appearance: {
			theme: "system",
			verbosity: "debug",
			thinking: false,
			tps: true,
			markdown: "source",
			toolOutput: "expanded",
		},
	});
	assert.equal(parsed.config.appearance?.theme, "system");
	assert.equal(parsed.config.appearance?.verbosity, "debug");
	assert.equal(parsed.config.appearance?.markdown, "source");
	assert.equal(parsed.config.appearance?.toolOutput, "expanded");
	const invalid = parseConfig({ appearance: { theme: "neon" } });
	assert.equal(invalid.config.appearance, undefined);
	assert.match(invalid.warnings.join(" "), /appearance/);

	const fallback = new IoAppearance({ theme: "io" });
	assert.equal(fallback.theme.background, ioDarkTheme.background);
});

test("io appearance applies theme, thinking and markdown to the shell and transcript", { skip: !supported }, async () => {
	const { createTestRenderer } = await import("@opentui/core/testing");
	const { IoShell } = await import("../src/tui/next/shell.js");
	const { IoTranscript } = await import("../src/tui/next/transcript.js");
	const { IoAppearance } = await import("../src/tui/next/appearance.js");
	const { ioLightTheme } = await import("../src/tui/next/theme.js");

	const setup = await createTestRenderer({ width: 110, height: 30 });
	const shell = new IoShell(setup.renderer, { cwd: "/home/oscar/project", version: "0.2.0" });
	const transcript = new IoTranscript({
		renderer: setup.renderer,
		container: shell.transcriptContainer,
		showThinking: false,
	});
	const appearance = new IoAppearance({ theme: "io-light", verbosity: "high" });

	try {
		appearance.applyToShell(shell);
		appearance.applyToTranscript(transcript);
		assert.equal(shell.currentTheme.background, ioLightTheme.background);

		transcript.apply({ type: "text_started", sessionID: "s", messageID: "m1" });
		transcript.apply({ type: "text_delta", sessionID: "s", messageID: "m1", delta: "## Plan\n\nbody" });
		transcript.apply({ type: "text_ended", sessionID: "s", messageID: "m1" });
		transcript.apply({ type: "reasoning_started", sessionID: "s", messageID: "m1" });
		transcript.apply({ type: "reasoning_delta", sessionID: "s", messageID: "m1", delta: "reasoning" });
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /reasoning/);
		assert.doesNotMatch(setup.captureCharFrame(), /## Plan/);

		transcript.setMarkdown(false);
		await setup.renderOnce();
		assert.match(setup.captureCharFrame(), /## Plan/);

		transcript.setShowThinking(false);
		transcript.setMarkdown(true);
		await setup.renderOnce();
		assert.doesNotMatch(setup.captureCharFrame(), /reasoning/);
		assert.doesNotMatch(setup.captureCharFrame(), /## Plan/);
	} finally {
		transcript.dispose();
		shell.dispose();
		await setup.dispose();
	}
});
