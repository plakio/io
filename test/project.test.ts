import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the project license is MIT and matches package metadata", () => {
	const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		license?: string;
	};
	assert.equal(packageJson.license, "MIT");
	const license = readFileSync(join(root, "LICENSE"), "utf8");
	assert.match(license, /^MIT License/);
	assert.match(license, /Copyright \(c\) 2026 Oscar Hugo Paz/);
	assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
});
