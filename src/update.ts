import { realpathSync } from "node:fs";

export const GITHUB_REPOSITORY = "plakio/io";
export const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`;

export interface ReleaseInfo {
	/** Normalized semver without prefix, e.g. "0.1.12". */
	version: string;
	/** Raw tag, e.g. "v0.1.12". */
	tag: string;
	publishedAt?: string;
	htmlUrl?: string;
}

/** True when the running entry point lives inside a Homebrew Cellar for io. */
export function isHomebrewManaged(entryPoint: string | undefined = process.argv[1]): boolean {
	if (process.env.IO_BREW_MANAGED === "1") return true;
	if (!entryPoint) return false;
	let resolved = entryPoint;
	try {
		resolved = realpathSync(entryPoint);
	} catch {
		// Tests and unusual launchers may pass a path that does not exist.
	}
	if (/[\\/]Cellar[\\/]io[\\/]/i.test(resolved)) return true;
	const prefix = process.env.HOMEBREW_PREFIX;
	return typeof prefix === "string" && prefix.length > 0 && resolved.startsWith(`${prefix}/Cellar/io/`);
}

type FetchFn = (
	input: string,
	init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

/** Parse a GitHub release tag (`v0.1.12` or `0.1.12`) to a normalized semver. */
export function parseReleaseVersion(tag: string): string | undefined {
	const match = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
	if (!match) return undefined;
	return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

/** Compare two `X.Y.Z` versions: positive if `a > b`, negative if `a < b`, zero if equal. */
export function compareVersions(a: string, b: string): number {
	const parse = (value: string): [number, number, number] | undefined => {
		const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
		return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
	};
	const left = parse(a);
	const right = parse(b);
	if (!left || !right) return a === b ? 0 : a.localeCompare(b) < 0 ? -1 : 1;
	for (let index = 0; index < 3; index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

/** Fetch the latest GitHub release for io. Returns undefined when not available. */
export async function fetchLatestRelease(
	fetcher: FetchFn = globalThis.fetch,
	options: { userAgent?: string; signal?: AbortSignal } = {},
): Promise<ReleaseInfo | undefined> {
	const response = await fetcher(RELEASES_API_URL, {
		headers: {
			Accept: "application/vnd.github+json",
			...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
		},
		signal: options.signal,
	});
	if (!response.ok) return undefined;
	const data = (await response.json()) as {
		tag_name?: unknown;
		published_at?: unknown;
		html_url?: unknown;
	};
	if (typeof data.tag_name !== "string") return undefined;
	const version = parseReleaseVersion(data.tag_name);
	if (!version) return undefined;
	return {
		version,
		tag: data.tag_name,
		publishedAt: typeof data.published_at === "string" ? data.published_at : undefined,
		htmlUrl: typeof data.html_url === "string" ? data.html_url : undefined,
	};
}
