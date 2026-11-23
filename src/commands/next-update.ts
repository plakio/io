import { spawnSync } from "node:child_process";
import { compareVersions, fetchLatestRelease, isHomebrewManaged } from "../update.js";
import { VERSION } from "../version.js";

export interface UpdateOutput {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

export async function updateCommand(output: UpdateOutput): Promise<number> {
	const latest = await fetchLatestRelease(undefined, { userAgent: `io/${VERSION}` });
	if (!latest) {
		output.stderr("io: could not check for updates (offline?)\n");
		return 1;
	}
	const changelog = latest.htmlUrl ?? `https://github.com/plakio/io/releases/tag/${latest.tag}`;
	if (compareVersions(latest.version, VERSION) <= 0) {
		output.stdout(`io ${VERSION} is up to date.\n`);
		return 0;
	}
	if (!isHomebrewManaged(process.execPath)) {
		output.stdout(`io ${latest.version} is available (running ${VERSION}).\nUpdate your checkout or run \`brew upgrade io\`.\nChangelog: ${changelog}\n`);
		return 0;
	}
	output.stdout(`updating io ${VERSION} → ${latest.version} with Homebrew…\n`);
	const brew = process.env.HOMEBREW_PREFIX ? `${process.env.HOMEBREW_PREFIX}/bin/brew` : "brew";
	const update = spawnSync(brew, ["update"], { encoding: "utf8", timeout: 120_000 });
	if (update.status !== 0) {
		output.stderr(`io: brew update failed: ${update.stderr?.trim() || `exit ${update.status}`}\n`);
		return 1;
	}
	const upgrade = spawnSync(brew, ["upgrade", "io"], { encoding: "utf8", timeout: 300_000 });
	if (upgrade.status !== 0) {
		output.stderr(`io: brew upgrade io failed: ${upgrade.stderr?.trim() || `exit ${upgrade.status}`}\n`);
		return 1;
	}
	const installed = spawnSync(brew, ["list", "--versions", "io"], { encoding: "utf8", timeout: 30_000 });
	const version = installed.stdout?.trim().split(/\s+/).at(-1);
	output.stdout(`io ${version ?? latest.version} installed. Restart io to use it.\nChangelog: ${changelog}\n`);
	return 0;
}
