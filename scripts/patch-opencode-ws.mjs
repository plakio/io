import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "scripts", "patches", "effect-node-ws.js");
const target = join(root, "node_modules", "@effect", "platform-node-shared", "dist", "NodeWS.js");

if (!existsSync(dirname(target))) {
	console.log("patch-opencode-ws: @effect/platform-node-shared not installed; skipping");
	process.exit(0);
}
const current = existsSync(target) ? readFileSync(target, "utf8") : "";
if (current.includes("import WebSocket from \"ws\"")) {
	console.log("patch-opencode-ws: already patched");
	process.exit(0);
}
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`patch-opencode-ws: patched ${target}`);
