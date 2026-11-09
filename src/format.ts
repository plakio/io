import { isAbsolute, relative, resolve, sep } from "node:path";

export interface UsageNumbers {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value < 0) return "—";
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) {
		const thousands = value / 1000;
		return `${thousands >= 100 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
	}
	const millions = value / 1_000_000;
	return `${millions >= 100 ? millions.toFixed(0) : millions.toFixed(1)}M`;
}

export function formatDuration(milliseconds: number): string {
	if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
	if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
	const minutes = Math.floor(milliseconds / 60_000);
	const seconds = Math.round((milliseconds % 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

export function formatSpeed(outputTokens: number, durationMs: number | undefined): string | undefined {
	if (!durationMs || durationMs <= 0 || outputTokens <= 0) return undefined;
	const tokensPerSecond = outputTokens / (durationMs / 1000);
	return `${tokensPerSecond >= 10 ? Math.round(tokensPerSecond) : tokensPerSecond.toFixed(1)} tok/s`;
}

export function formatUsage(usage: UsageNumbers | undefined): string | undefined {
	if (!usage) return undefined;
	const parts: string[] = [];
	if (usage.input > 0) parts.push(`in ${formatTokens(usage.input)}`);
	if (usage.output > 0) parts.push(`out ${formatTokens(usage.output)}`);
	if (usage.cacheRead > 0) parts.push(`cache ${formatTokens(usage.cacheRead)}`);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function formatContext(
	context: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
): string | undefined {
	if (!context || context.tokens === null || context.percent === null) return undefined;
	return `ctx ${context.percent.toFixed(context.percent < 10 ? 1 : 0)}%`;
}

export function formatCount(value: number): string {
	return value.toLocaleString("en-US");
}

export function shortSessionId(sessionId: string): string {
	return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

export function oneLine(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	const cut = normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd();
	return `${cut}…`;
}

/**
 * Render cwd in the footer the way Pi does: `$HOME` becomes `~` and anything
 * outside home stays absolute (`~/io`, `/tmp/x`). Used for the `~/io (main)`
 * bottom-bar label.
 */
export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}
