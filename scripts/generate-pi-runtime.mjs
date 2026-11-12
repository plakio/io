import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The bundled Pi SDK detects its own version by walking up to the nearest
// package.json. From the bundle that walk lands on io's package.json, so the
// SDK presents io's version in its User-Agent and pi.dev rejects it with 404
// (no remote model catalog). Ship a descriptor with the Pi SDK's real
// name/version next to the bundle (see src/pi-env.ts).
const piPackagePath = new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url);
const piPackage = JSON.parse(readFileSync(piPackagePath, "utf8"));
const descriptor = {
	name: typeof piPackage.name === "string" ? piPackage.name : "@earendil-works/pi-coding-agent",
	version: typeof piPackage.version === "string" ? piPackage.version : "0.0.0",
};
mkdirSync(join("dist", "runtime"), { recursive: true });
writeFileSync(join("dist", "runtime", "package.json"), `${JSON.stringify(descriptor, null, 2)}\n`);

// Pi's interactive components load their theme JSON from disk using
// PI_PACKAGE_DIR. In io's bundle that points at runtime/, so ship the built-in
// themes where getThemesDir() looks for them.
const themeSource = new URL(
	"../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/",
	import.meta.url,
);
const themeTarget = join("dist", "runtime", "dist", "modes", "interactive", "theme");
mkdirSync(themeTarget, { recursive: true });
for (const name of ["dark.json", "light.json"]) {
	cpSync(new URL(name, themeSource), join(themeTarget, name));
}
process.stdout.write(`Wrote dist/runtime/package.json (pi ${descriptor.version})\n`);
