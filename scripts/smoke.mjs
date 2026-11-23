#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const reported = execFileSync("./dist-next/io", ["--version"], { encoding: "utf8" }).trim();
if (reported !== `io ${version}`) {
	throw new Error(`dist-next/io --version reported "${reported}", expected "io ${version}"`);
}

execFileSync("./dist-next/io", ["--help"], { stdio: "ignore" });

const notices = statSync("dist-next/THIRD_PARTY_NOTICES.txt");
if (notices.size === 0) throw new Error("dist-next/THIRD_PARTY_NOTICES.txt is empty");
const noticeText = readFileSync("dist-next/THIRD_PARTY_NOTICES.txt", "utf8");
if (noticeText.includes("PACKAGES WITH DECLARED LICENSES")) {
	throw new Error("dist-next/THIRD_PARTY_NOTICES.txt still contains unresolved packages");
}
console.log(`io ${version} smoke test passed`);
