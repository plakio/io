import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AssistantBlock } from "../src/tui/components.js";

// Synthetic worst case: re-render a growing markdown response after every
// update instead of the normal 50 ms TUI throttle. Reports per-update cost.
const paragraph =
	"IO keeps the interface small and predictable. The model streams text, tools " +
	"show their commands, and the footer reports real provider usage. ";

let source = "# Streaming benchmark\n\n";
for (let index = 0; index < 120; index++) {
	source += `${paragraph}\n`;
	if (index % 20 === 0) source += "```sh\necho benchmark\n```\n";
}

const step = Math.max(1, Math.ceil(source.length / 250));
const updates: string[] = [];
for (let index = 0; index < source.length; index += step) {
	updates.push(source.slice(0, index + step));
}

const block = new AssistantBlock(() => {});
const timings: number[] = [];

for (const text of updates) {
	const started = performance.now();
	block.setMessage(fauxAssistantMessage(text), false);
	block.render(100);
	timings.push(performance.now() - started);
}

timings.sort((left, right) => left - right);
const percentile = (value: number) => timings[Math.min(timings.length - 1, Math.floor(timings.length * value))] ?? 0;
const round = (value: number) => Math.round(value * 100) / 100;

process.stdout.write(
	[
		`response: ${source.length} chars`,
		`updates: ${timings.length}`,
		`median: ${round(percentile(0.5))} ms`,
		`p95: ${round(percentile(0.95))} ms`,
		`max: ${round(timings[timings.length - 1] ?? 0)} ms`,
	].join("\n") + "\n",
);
