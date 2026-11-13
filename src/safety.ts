import type { PermissionMode, ShellPermissionRule } from "./config.js";

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
		// `git push origin +main` force-updates the remote branch.
		pattern: /(^|[\s;&|()])git\s+push\b[^\n]*\s\+[^\s]+/,
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

function stripShellQuoting(command: string): string {
	let output = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (quote) {
			if (char === quote) {
				quote = undefined;
				continue;
			}
			if (char === "\\" && quote === '"' && index + 1 < command.length) {
				output += command[++index];
				continue;
			}
			output += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			output += command[++index];
			continue;
		}
		output += char;
	}
	return output;
}

function normalizeForMatching(command: string): string {
	// Canonicalize quoting and backslash escapes before matching. A shell does
	// not care whether `rm` is written as `rm`, `"rm"`, or `r\m`; the risk
	// rules must see the same command the shell will execute.
	const normalized = stripShellQuoting(command.replace(/\\\r?\n/g, " "));
	return normalized.replace(/\s+/g, " ");
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

const READONLY_COMMANDS = new Set([
	"basename",
	"cat",
	"column",
	"cut",
	"date",
	"df",
	"diff",
	"dirname",
	"du",
	"file",
	"find",
	"git",
	"grep",
	"head",
	"hostname",
	"id",
	"jq",
	"ls",
	"printf",
	"pwd",
	"realpath",
	"rg",
	"sort",
	"stat",
	"tail",
	"tr",
	"tree",
	"uname",
	"uniq",
	"wc",
	"which",
	"whoami",
]);

const GIT_READONLY_COMMANDS = new Set([
	"blame",
	"cat-file",
	"check-attr",
	"check-ignore",
	"describe",
	"diff",
	"for-each-ref",
	"grep",
	"log",
	"ls-files",
	"ls-tree",
	"merge-base",
	"name-rev",
	"rev-list",
	"rev-parse",
	"show",
	"show-ref",
	"shortlog",
	"status",
]);

function basename(value: string): string {
	const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
	return slash === -1 ? value : value.slice(slash + 1);
}

/**
 * Shell syntax that can write, chain commands, or expand arbitrary values.
 * Quotes are respected so a read-only search like `rg 'a|b'` is still allowed.
 */
function hasUnsafeShellSyntax(command: string): boolean {
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (char === undefined) continue;
		if (quote === "'") {
			if (char === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			if (char === '"') {
				quote = undefined;
				continue;
			}
			if (char === "\\") {
				index++;
				continue;
			}
			if (char === "$" || char === "`") return true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "\\") {
			index++;
			continue;
		}
		if (char === "\n" || char === "\r") return true;
		if (char === "$" || char === "`") return true;
		if (";&|<>".includes(char)) return true;
	}
	return false;
}

/**
 * Strict, conservative policy for the explore subagent. It is an allowlist of
 * read commands, not a full shell parser: pipelines, redirections, command
 * substitution, and unknown binaries are rejected.
 */
export function isReadonlyCommand(command: string): boolean {
	if (hasUnsafeShellSyntax(command)) return false;
	const normalized = normalizeForMatching(command);
	const tokens = normalized.split(" ").filter(Boolean);
	const executable = tokens[0];
	if (!executable) return false;
	const name = basename(executable);
	if (!READONLY_COMMANDS.has(name)) return false;
	if (name === "find") {
		const forbidden = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"];
		if (tokens.some((token) => forbidden.includes(token))) return false;
	}
	if (name === "sort") {
		if (
			tokens.some(
				(token) =>
					token === "-o" ||
					token.startsWith("-o") ||
					token.startsWith("--output") ||
					token === "-T" ||
					token.startsWith("--temporary-directory") ||
					token === "--compress-program" ||
					token.startsWith("--compress-program="),
			)
		) {
			return false;
		}
	}
	if (name === "tree" && tokens.some((token) => token === "-o" || token.startsWith("--output"))) {
		return false;
	}
	if (name === "rg" && tokens.some((token) => token === "--pre" || token.startsWith("--pre="))) {
		return false;
	}
	if (name === "date" && tokens.some((token) => token === "-s" || token.startsWith("--set"))) {
		return false;
	}
	if (name === "hostname" && tokens.length > 1) {
		return false;
	}
	if (name === "git") {
		const subcommand = tokens[1];
		if (!subcommand || !GIT_READONLY_COMMANDS.has(subcommand)) return false;
		const forbidden = [
			"--output",
			"--ext-diff",
			"--textconv",
			"--open-files-in-pager",
			"--paginate",
			"-c",
			"--exec-path",
		];
		if (tokens.some((token) => forbidden.includes(token) || token.startsWith("--output="))) return false;
	}
	return true;
}

/** Built-in deny rules, always active and not overridable by config. */
const BUILT_IN_DENY_RULES: readonly ShellPermissionRule[] = [
	{ resource: "*auth.json*", effect: "deny" },
	// `auth?json` covers shell-glob style single-character substitutions such as auth.?son.
	{ resource: "*auth?json*", effect: "deny" },
	{ resource: "*.env", effect: "deny" },
	{ resource: "*.env.*", effect: "deny" },
	{ resource: "*.ssh/id_*", effect: "deny" },
	{ resource: "*.aws/credentials*", effect: "deny" },
	{ resource: "*application_default_credentials.json*", effect: "deny" },
	{ resource: "*.git-credentials*", effect: "deny" },
	{ resource: "*.docker/config.json*", effect: "deny" },
	{ resource: "*.npmrc*", effect: "deny" },
	{ resource: "*.netrc*", effect: "deny" },
];

/**
 * Wildcard match for permission rules (opencode semantics): `*` spans any
 * characters, `?` exactly one. A pattern ending in ` *` also matches the bare
 * command (`git push *` matches `git push`).
 */
export function wildcardMatch(pattern: string, value: string): boolean {
	const normalizedPattern = normalizeForMatching(pattern);
	const normalizedValue = normalizeForMatching(value);
	const toRegex = (source: string): RegExp => {
		let body = "";
		for (const char of source) {
			if (char === "*") body += ".*";
			else if (char === "?") body += ".";
			else body += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
		return new RegExp(`^${body}$`);
	};
	if (toRegex(normalizedPattern).test(normalizedValue)) return true;
	if (normalizedPattern.endsWith(" *")) {
		return toRegex(normalizedPattern.slice(0, -2)).test(normalizedValue);
	}
	return false;
}

/**
 * Evaluate every matching rule (built-ins first, then the user's, last wins).
 * Returns undefined when nothing matches.
 */
export function matchShellRule(
	rules: readonly ShellPermissionRule[],
	command: string,
): ShellPermissionRule | undefined {
	let matched: ShellPermissionRule | undefined;
	for (const rule of [...BUILT_IN_DENY_RULES, ...rules]) {
		if (wildcardMatch(rule.resource, command)) matched = rule;
	}
	return matched;
}

/** Whether the command matched one of the non-overridable built-in denies. */
export function matchesBuiltInDeny(command: string): boolean {
	return BUILT_IN_DENY_RULES.some((rule) => wildcardMatch(rule.resource, command));
}

/** Permission decision for one shell command, before the interactive ask. */
export type ShellDecision = "allow" | "deny" | "ask";

/**
 * Decide what to do with one shell command. Explicit rules always win over the
 * mode: a `deny` rule blocks even in `auto`, and an `ask` rule still asks. The
 * mode only changes what happens to commands that would otherwise ask because
 * of the built-in risk patterns.
 */
export function decideShellPermission(
	rules: readonly ShellPermissionRule[],
	command: string,
	mode: PermissionMode = "ask",
): { decision: ShellDecision; rule?: ShellPermissionRule; reason?: string } {
	// Built-in denies (credentials and secrets) are non-overridable.
	if (matchesBuiltInDeny(command)) {
		const builtIn = BUILT_IN_DENY_RULES.find((rule) => wildcardMatch(rule.resource, command));
		return { decision: "deny", rule: builtIn, reason: "built-in deny rule" };
	}
	const matched = matchShellRule(rules, command);
	if (matched) {
		if (matched.effect === "deny") return { decision: "deny", rule: matched, reason: `permissions rule "${matched.resource}"` };
		if (matched.effect === "allow") return { decision: "allow", rule: matched };
		return { decision: "ask", rule: matched, reason: `permissions rule "${matched.resource}"` };
	}
	const risk = assessCommand(command);
	if (risk.dangerous) {
		if (mode === "auto") return { decision: "allow", reason: `${risk.reason} (auto mode)` };
		return { decision: "ask", reason: risk.reason };
	}
	return { decision: "allow" };
}

/**
 * Pattern stored when the user answers "allow always". Dangerous commands are
 * remembered exactly: broadening `rm -rf build` to `rm -rf *` would also
 * pre-approve `rm -rf /`. Ordinary commands use the first two tokens
 * (`git push *`), which keeps the list short without widening risk.
 */
export function shellPatternFor(command: string): string {
	const normalized = normalizeForMatching(command);
	if (assessCommand(command).dangerous) return normalized;
	const [first, second] = normalized.split(" ");
	if (first && second) return `${first} ${second} *`;
	return normalized;
}

const PROVIDER_ENV_NAMES = [
	"OPENCODE_API_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	// Bedrock also accepts the standard AWS credential chain. Those values are
	// provider credentials too; keep them out of model-run commands.
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_CONFIG_FILE",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
] as const;

/**
 * Provider keys are not needed by agent commands. Keep them out of the child
 * environment so a command like `env` cannot print them into the transcript.
 */
export function sanitizeBashEnvironment(
	env: NodeJS.ProcessEnv,
	extraNames: readonly string[] = [],
): NodeJS.ProcessEnv {
	const clean = { ...env };
	for (const name of PROVIDER_ENV_NAMES) delete clean[name];
	for (const name of extraNames) delete clean[name];
	return clean;
}
