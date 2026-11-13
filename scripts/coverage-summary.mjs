#!/usr/bin/env node

// Render Node's --experimental-test-coverage output as a compact Markdown table
// for GITHUB_STEP_SUMMARY. The raw report is still kept as a CI artifact.
import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "coverage.txt";
const text = readFileSync(path, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
const lines = text.split("\n");
const start = lines.findIndex((line) => line.includes("start of coverage report"));
const end = lines.findIndex((line) => line.includes("end of coverage report"));
if (start === -1 || end === -1 || end <= start) {
	throw new Error(`No coverage report found in ${path}`);
}

const rows = [];
for (const line of lines.slice(start + 1, end)) {
	const cleaned = line.replace(/^[ℹ#]\s*/u, "").trim();
	if (!cleaned || /^-+$/.test(cleaned)) continue;
	const cells = cleaned.split("|").map((cell) => cell.trim());
	if (cells.length < 5) continue;
	const [file, linePercent, branchPercent, funcsPercent, uncovered] = cells;
	if (!file || file === "file") continue;
	if (!linePercent && !branchPercent && !funcsPercent) {
		rows.push(`| **${file}** |  |  |  |  |`);
		continue;
	}
	rows.push(`| ${file} | ${linePercent} | ${branchPercent} | ${funcsPercent} | ${uncovered} |`);
}

if (rows.length === 0) throw new Error(`Coverage report in ${path} had no rows`);
process.stdout.write("## Coverage\n\n");
process.stdout.write("| File | Lines | Branches | Funcs | Uncovered |\n");
process.stdout.write("| --- | ---: | ---: | ---: | --- |\n");
process.stdout.write(`${rows.join("\n")}\n`);
