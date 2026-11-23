export const APP_NAME = "io";
export const APP_TAGLINE = "minimal AI harness by Plak";

import { readFileSync } from "node:fs";

function readPackageVersion(): string {
	const injected = process.env.IO_VERSION;
	if (injected && injected.length > 0) return injected;
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version?: unknown;
		};
		return typeof pkg.version === "string" ? pkg.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

export const VERSION = readPackageVersion();
