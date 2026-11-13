#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const reported = execFileSync(process.execPath, ["dist/cli.js", "--version"], {
	encoding: "utf8",
}).trim();
if (reported !== `io ${version}`) {
	throw new Error(`dist/cli.js --version reported "${reported}", expected "io ${version}"`);
}

execFileSync(process.execPath, ["dist/cli.js", "--help"], { stdio: "ignore" });

const notices = statSync("dist/THIRD_PARTY_NOTICES.txt");
if (notices.size === 0) throw new Error("dist/THIRD_PARTY_NOTICES.txt is empty");
const noticeText = readFileSync("dist/THIRD_PARTY_NOTICES.txt", "utf8");
if (noticeText.includes("PACKAGES WITH DECLARED LICENSES")) {
	throw new Error("dist/THIRD_PARTY_NOTICES.txt still contains unresolved packages");
}
