import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The bundled Pi SDK detects its own version by walking up from its code to
 * the nearest package.json. In io's bundle that walk lands on io's
 * package.json, so the SDK presents io's version (e.g. "0.1.11") in its
 * User-Agent. pi.dev rejects such unknown versions with 404, which silently
 * disables the remote model catalog: no refresh, no new models.
 *
 * Each bundle ships a descriptor (`runtime/package.json` next to cli.js,
 * generated at build time with the Pi SDK's real name/version). Point the SDK
 * at it via PI_PACKAGE_DIR before any Pi module loads. In dev (tsx) there is
 * no descriptor next to src/, detection finds the real package, and this
 * no-ops. A pre-set PI_PACKAGE_DIR always wins.
 */
if (process.env.PI_PACKAGE_DIR === undefined) {
	const descriptorDir = join(dirname(fileURLToPath(import.meta.url)), "runtime");
	if (existsSync(join(descriptorDir, "package.json"))) {
		process.env.PI_PACKAGE_DIR = descriptorDir;
	}
}
