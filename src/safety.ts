export interface CommandRisk {
	dangerous: boolean;
	reason?: string;
}

interface RiskRule {
	pattern: RegExp;
	reason: string;
}

/**
 * Conservative list of commands that can cause irreversible damage or execute
 * remote content. Ordinary file edits, installs, and repository operations are
 * intentionally not listed: the shell is IO's main tool and confirming every
 * command would make it useless.
 */
const RISK_RULES: readonly RiskRule[] = [
	{
		pattern: /(^|[\s;&|()])rm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive(?:\s+--force)?|--force\s+--recursive)\b/,
		reason: "recursive forced delete",
	},
	{
		pattern: /(^|[\s;&|()])rm\s+(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive)\b[^\n]*(?:\s|^)(?:\/|~|\$HOME)(?:\s|$)/,
		reason: "recursive delete of a root or home path",
	},
	{ pattern: /(^|[\s;&|()])sudo\b/, reason: "privilege escalation" },
	{ pattern: /(^|[\s;&|()])doas\b/, reason: "privilege escalation" },
	{ pattern: /(^|[\s;&|()])mkfs(?:\.[a-zA-Z0-9]+)?\b/, reason: "filesystem formatting" },
	{ pattern: /(^|[\s;&|()])(shutdown|reboot|halt|poweroff)\b/, reason: "system power control" },
	{
		pattern: /(^|[\s;&|()])dd\b[^\n]*\bof=\/dev\//,
		reason: "raw write to a device",
	},
	{
		pattern: /(^|[\s;&|()])(fdisk|sfdisk|parted|wipefs)\b/,
		reason: "disk partitioning or wiping",
	},
	{
		pattern: /(^|[\s;&|()])git\s+push\b[^\n]*(?:--force(?:-with-lease)?\b|\s-f\b)/,
		reason: "force push",
	},
	{
		pattern: /(^|[\s;&|()])git\s+reset\s+--hard\b/,
		reason: "hard reset discards working changes",
	},
	{
		pattern: /(^|[\s;&|()])git\s+clean\b[^\n]*\s-[a-zA-Z]*f/,
		reason: "forced git clean removes untracked files",
	},
	{
		pattern: /(^|[\s;&|()])git\s+checkout\s+(?:-f|--force)\b/,
		reason: "forced checkout discards working changes",
	},
	{
		pattern: /(^|[\s;&|()])find\b[^\n]*\s-delete\b/,
		reason: "find -delete removes matching files",
	},
	{
		pattern: /(^|[\s;&|()])(curl|wget)\b[^\n]*\|\s*(?:ba|z|da|k)?sh\b/,
		reason: "piping remote content into a shell",
	},
	{
		pattern: /:\s*\(\s*\)\s*\{[^\n]*:\s*\|/,
		reason: "fork bomb",
	},
	{
		pattern: /(^|[\s;&|()])chmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\s+[0-7]*777\s+\/(?:\s|$)/,
		reason: "recursive world-writable permissions on root",
	},
];

function normalizeForMatching(command: string): string {
	return command.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ");
}

export function assessCommand(command: string): CommandRisk {
	const normalized = normalizeForMatching(command);
	for (const rule of RISK_RULES) {
		if (rule.pattern.test(normalized)) {
			return { dangerous: true, reason: rule.reason };
		}
	}
	// `rm -r -f path` is equivalent to `rm -rf path` but uses separate flags.
	if (
		/(^|[\s;&|()])rm\b/.test(normalized) &&
		/(^|\s)(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/.test(normalized) &&
		/(^|\s)(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\s|$)/.test(normalized)
	) {
		return { dangerous: true, reason: "recursive forced delete" };
	}
	return { dangerous: false };
}

export function isDangerousCommand(command: string): boolean {
	return assessCommand(command).dangerous;
}

/**
 * Provider keys are not needed by agent commands. Keep them out of the child
 * environment so a command like `env` cannot print them into the transcript.
 */
export function sanitizeBashEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const clean = { ...env };
	delete clean.OPENCODE_API_KEY;
	delete clean.AWS_BEARER_TOKEN_BEDROCK;
	return clean;
}
