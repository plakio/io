import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "node_modules", "@effect", "platform-node-shared", "dist", "NodeWS.js");
copyFileSync(join(root, "patches", "NodeWS.js"), target);
console.log(`patched ${target}`);
