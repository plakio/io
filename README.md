# io

IO is a minimal AI harness for the terminal, developed and maintained by [Plak](https://github.com/plakio).

It gives the model a Bash shell — and optional subagents — and keeps everything else small: a Pi-styled terminal interface, persistent sessions, real token accounting, and the [Pi SDK](https://github.com/earendil-works/pi) underneath.

IO is not only a coding agent. It is useful for programming, file manipulation, system administration, repository work, research with standard command-line utilities, and automation.

## Philosophy

> Give the model a shell and keep everything else simple.

There is no MCP integration, plugin marketplace, browser automation, or large custom tool collection. The model uses `bash`, `git`, `rg`, `find`, `sed`, `awk`, `curl`, `jq`, and the rest of the Unix toolbox.

The shell is intentionally powerful and runs with your user permissions. IO's permission rules are a speed bump for mistakes, **not a sandbox**: see [Security](#security).

## Features

- Bash as the primary tool, plus general and read-only exploration subagents.
- Streaming terminal output with clear command/tool separation.
- OpenCode Go API-key authentication and OpenAI Codex OAuth through the Pi SDK.
- Custom OpenAI-compatible endpoints through `models.json`.
- Model discovery from the SDK catalog, with `/model` switching in-session.
- Persistent provider/model preferences and resumable sessions.
- Headless runs with `io run` for scripts, pipes, and automation.
- Project context from `AGENTS.md` and skills from `~/.agents/skills`.
- Automatic context compaction before the model window fills.
- Configurable shell permissions, plus per-command confirmation in the TUI.
- Multiline input and large pastes shown as editable text, never `[pasted text]`.
- Input tokens, output tokens, context usage, generation speed, and live queue status from actual SDK/provider data.
- Git change inspection with `/diff`.
- Dangerous-command confirmation, visible commands, and Ctrl+C/Esc cancellation.
- Minimal, keyboard-first interface styled with Pi's terminal components (`IO_PI_THEME=light` switches the theme).

## Requirements

- macOS ARM64/x64 or Linux ARM64/x64.
- A UTF-8 terminal with ANSI escape support.
- Node.js 22.19 or newer. Homebrew installs Node as a dependency.
- Git for `/diff` and git workflows.

## Installation

```bash
brew install plakio/tap/io
```

The fully qualified tap name is required because `homebrew/core` contains an unrelated formula named `io`.

From source:

```bash
git clone git@github.com:plakio/io.git
cd io
npm ci --ignore-scripts
npm run build
node dist/cli.js
```

## Authentication

OpenCode Go:

```bash
io auth login opencode-go
# or export OPENCODE_API_KEY
```

OpenAI Codex uses the ChatGPT OAuth flow exposed by the Pi SDK:

```bash
io auth login openai-codex
```

Amazon Bedrock uses a bearer token or the AWS credential chain. For Kimi K3 (Global) use a bearer token:

```bash
io auth login amazon-bedrock
# or export AWS_BEARER_TOKEN_BEDROCK
io config set model amazon-bedrock/global.moonshotai.kimi-k3
```

### OpenAI-compatible providers

Endpoints that speak the OpenAI Chat Completions API can be added in
`~/.local/share/io/models.json` (or `$XDG_DATA_HOME/io/models.json`). This is
the Pi SDK `models.json` format; io loads it at startup and on `/reload`, and
lists its providers after the built-in ones.

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "50x": {
      "name": "50x",
      "baseUrl": "https://api.ai.50x.energy/v1",
      "api": "openai-completions",
      "apiKey": "$FIFTYX_API_KEY",
      "models": [
        {
          "id": "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          "name": "DeepSeek V4.1 Flash 1017",
          "reasoning": true,
          "contextWindow": 1000000,
          "maxTokens": 384000,
          "thinkingLevelMap": {
            "off": null,
            "minimal": "low",
            "low": "low",
            "medium": "high",
            "high": "high",
            "xhigh": "xhigh",
            "max": "max"
          }
        }
      ]
    }
  }
}
```

`contextWindow` and `maxTokens` are not discovered from the endpoint: Pi
defaults them to 128 000 and 16 384, so a model with a wider window keeps
compacting at 128k until you declare it here.

`thinkingLevelMap` translates io's thinking levels to provider values. The 50x
endpoint accepts `low`, `high`, `xhigh`, and `max`; without the map Pi's
default `medium` is rejected. Omit the map if the endpoint accepts the
standard OpenAI `reasoning_effort` values.

`apiKey` accepts a literal value, `$NAME`/`${NAME}` environment interpolation,
or `!command`. Other supported APIs include `openai-responses`,
`anthropic-messages`, and `google-generative-ai`; omit `api` only when the
provider defines it per model. Prefer environment interpolation over a literal
key: `models.json` itself is readable by the agent's shell, while referenced
environment variables are stripped from Bash commands. The provider ID becomes
the model namespace:

```bash
export FIFTYX_API_KEY=...
io models 50x
io config set model 50x/deepseek-ai/DeepSeek-V4.1-Flash-1017
io run -m 50x/deepseek-ai/DeepSeek-V4.1-Flash-1017 "summarize this repo"
```

`io auth login 50x` also stores a key in io's credential file for a
`models.json` provider. Custom provider catalogs are static, so
`io models --refresh 50x` has nothing to fetch.

Check status and remove credentials:

```bash
io auth status
io auth logout [provider]
```

Credentials are stored in `~/.local/share/io/auth.json` (or `$XDG_DATA_HOME/io/auth.json`) with owner-only permissions. They are separate from general configuration. OAuth refresh and expiry handling belong to the Pi SDK.

## Models

```bash
io models                       # authenticated models
io models opencode-go           # one provider
io models --refresh             # refresh the SDK catalog first
io --model opencode-go/glm-5.3  # one run
```

Inside a session:

```text
/model                  select from authenticated models
/model provider/model   select directly
/models                 list authenticated models
```

The selected provider and model are shown in the footer and persisted in `~/.config/io/config.json` (or `$XDG_CONFIG_HOME/io/config.json`).

## Usage

```bash
io
```

Start in the current working directory. On first use, authenticate with a provider.

### Headless

```bash
io run "summarize this repository"     # print the answer and exit
io run --continue "what changed?"      # continue the latest session
io run --session <id-prefix> "..."     # continue a specific session
io run -m opencode-go/glm-5.3 "..."    # override the model for this run
io run --mode auto "run the tests"     # override permission mode for this invocation
io run --stats "review this diff"      # print tokens, cost, and duration to stderr
io run --fail-on-tool-error "deploy"   # exit non-zero if a command fails
echo "explain this error" | io run     # read the prompt from stdin
io run --no-stdin "..."              # never wait for stdin
```

Headless runs write assistant text to stdout. Piped stdin is read only when no prompt argument is given unless `--stdin` is explicit. Commands that need confirmation are denied because there is no TUI; add a `permissions` allow rule, use `--mode auto`, or set `"permissionMode": "auto"` in config. `--no-save` prevents a headless run from changing the default model. `--stats` and `--fail-on-tool-error` are intended for CI. A completed turn exits 0 (even without text if it made tool calls); provider errors exit 1; an interrupted run exits 130.

### Project context

IO loads context automatically in both interactive and headless runs:

- `AGENTS.md` (or `AGENTS.override.md`, `CLAUDE.md`) from the working directory and its ancestors, including `~/AGENTS.md`.
- Skills from `~/.agents/skills` and `<project>/.agents/skills`.

Disable either source with:

```bash
io config set contextFiles off
io config set skills off
```

Sessions compact their context automatically before the model window fills. Use `/compact` to force it.

### Subagents

The build agent can delegate focused work to a subagent with fresh context:

- `general` — full shell access; useful for independent edits or research.
- `explore` — read-only allowlist; rejects redirections, pipelines, command substitution, writes, and unknown binaries.

Subagent sessions are in-memory and do not appear in `/resume`. Per-agent models can be set in `config.json`:
```json
{ "agents": { "explore": { "model": "opencode-go/glm-5.3" } } }
```

### Keys

| Key | Action |
| --- | --- |
| `Enter` | Send prompt |
| `Tab` after `/` | Complete slash commands |
| `Shift+Enter` or `Ctrl+J` | Insert newline |
| Backslash then `Enter` | Insert newline on terminals without Shift+Enter |
| `Esc` or `Ctrl+C` | Cancel generation or a running command |
| `Ctrl+C` twice | Exit when the prompt is empty |
| `Ctrl+O` | Expand or collapse tool output |
| `Ctrl+D` | Exit when the prompt is empty |

Pastes are inserted as the actual text. Large pasted content can be reviewed and edited in the input area before sending.

Prefix a line with `!` to run a shell command directly; its output is added to context. Use `!!` to exclude the output from context (the transcript still shows it).

### Session commands

```text
/help            show commands and keys
/model [ref]     select a model
/models          list authenticated models
/scope           select models Ctrl+P cycles through
/effort [level]  select or set thinking effort
/thinking        alias for /effort
/verbosity [lvl] set detail: low hides tool panels, high shows thinking and expanded tools
/mode [ask|auto] shell approval mode: confirm destructive commands, or run them
/permissions     alias for /mode
/diff [path]     show git status, stat, and patch
/session         show session details and token usage
/new             start a new session
/resume          switch to an earlier session
/fork            fork from a previous message
/compact         compact the session context
/name [text]     name the current session
/export [fmt]    export the session (html or jsonl)
/agent           show the active agent
/copy            copy the last assistant response
/debug           write UI/session diagnostics to a log file
/reload          reload config, resources, and model catalogs
/update          install the latest io release with Homebrew
/editor          compose the prompt in $EDITOR
/login           authentication instructions
/logout          credential removal instructions
/quit            exit
```

### Sessions

```bash
io --continue              # continue the most recent session in this directory
io sessions                # list recent sessions for this directory
io --session <id-prefix>   # open a specific session
io sessions prune          # dry-run: show sessions older than 30 days
io sessions prune --older-than 7 --yes
```

Session files are stored under `~/.local/share/io/sessions` (or `$XDG_DATA_HOME/io/sessions`) and grouped by working directory.

## Configuration

```bash
io config                  # show or edit preferences interactively
io config show             # show paths and current preferences
io config edit             # interactive provider, model, and thinking selection
io config set provider opencode-go
io config set model opencode-go/deepseek-v4.1-flash
io config set thinking high
io config set verbosity low
io config set mode auto
io config set bell off
io config set skills off
io config set contextFiles off
```

`io models` and `io sessions` are also interactive in a terminal: `io models` can set the default model, and `io sessions` can resume a selected session. Both remain non-interactive when their output is piped.

`/update` checks the latest GitHub release and, when io runs from a Homebrew Cellar, runs `brew update && brew upgrade io` itself, then verifies the installed version with `brew list --versions io`. Restart io afterwards to load the new build.

Configuration lives in `~/.config/io/config.json`. Credentials are never stored there.

`verbosity` controls the transcript: `low` shows assistant text and notices while hiding tool panels, `normal` collapses tool panels and hides reasoning, and `high` shows reasoning plus expanded tool output. Change it in-session with `/verbosity low|normal|high` (persisted) or with `io config set verbosity <level>`.

Shell permissions use the opencode rule shape. Rules match the whole command, the last matching rule wins, and built-in denies for credential files (`.env`, `auth.json`) cannot be overridden:

```json
{
  "permissions": [
    { "resource": "git push *", "effect": "allow" },
    { "resource": "npm publish", "effect": "ask" },
    { "resource": "rm -rf *", "effect": "deny" }
  ]
}
```

Approval is a selection, not a keystroke: `↑`/`↓` to choose, `Enter` to confirm, `Esc` to deny. The default choice is **Deny**, so a stray Enter never approves a destructive command, and typing while the prompt is open cannot approve one either. `Always allow` remembers a rule. Dangerous commands are stored exactly (`rm -rf build`), while ordinary commands use their first two tokens (`git status *`).

While a prompt is open IO says so three ways, so a missed prompt cannot pass for a hung session: the spinner becomes `⏸ Waiting for approval (12s): <command>` above the editor, a line in the transcript records the request and its outcome, and the terminal bell rings (again after 30s and 90s) unless `bell` is `false`.

`permissionMode` decides what happens to commands the built-in risk patterns would confirm:

```json
{ "permissionMode": "auto" }
```

- `ask` (default) — confirm them.
- `auto` — run them without confirmation. Built-in denies for credential files still apply, and explicit `deny` rules still win. While it is on, the footer shows a red `AUTO-APPROVE` badge.

Switch it in-session with `/mode ask` or `/mode auto` (persisted for the next session), with `--mode ask|auto` for this invocation, or with `io config set mode ask|auto`. The mode and rule list are captured in memory when the session starts; editing `config.json` during a session does not change the active policy until an explicit `/reload`. A read-only subagent never inherits `auto` and rejects writes and shell metacharacters. A command blocked without any way to ask the user is reported to the model and to the transcript instead of failing silently.

Environment variables:

- `OPENCODE_API_KEY` — OpenCode Go API key.
- `AWS_BEARER_TOKEN_BEDROCK` — Amazon Bedrock bearer token.
- Any environment variable referenced as `$NAME` or `${NAME}` in `models.json` credentials or headers.
- `XDG_CONFIG_HOME`, `XDG_DATA_HOME` — standard directory overrides.
- `IO_CONFIG_DIR`, `IO_DATA_DIR` — IO-specific directory overrides (useful for tests).

## Security

See [SECURITY.md](SECURITY.md) for the threat model and reporting process.

IO runs commands as your user, in your shell. The permission layer is a **speed bump for mistakes and a visibility aid, not a sandbox**. Treat prompt injection and untrusted repositories accordingly.

- Every command is shown in the tool panel. With `verbosity low` the panel is hidden; use `/verbosity normal` or `high` when you need to audit commands.
- A conservative set of destructive patterns (recursive deletes, force pushes, hard resets, disk/system commands, remote code piping, privilege escalation) requires an explicit approval choice, defaulting to deny. Quoting and escape variants are canonicalized before matching, but shell parsing is not complete.
- `permissions` rules can pre-approve or deny commands; built-in denies for credential files (`auth.json`, `.env*`, SSH private keys, cloud credentials) cannot be overridden.
- Permission state is session-local. Rewriting `config.json` does not change the active policy; a new io process or an explicit `/reload` reads it again, so `config.json` is not a security boundary.
- Denied commands are reported to the model and are not executed.
- Failed commands leave a `✖ <tool> failed (exit N)` notice in the transcript, and the terminal status switches to error instead of done.
- Running commands are cancelled through the SDK's abort signal on `Esc` or `Ctrl+C`.
- `OPENCODE_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, the AWS credential chain variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, and related file pointers), and environment variables referenced by `models.json` credentials are removed from the environment inherited by commands. Other ambient variables (for example `GH_TOKEN` or `SSH_AUTH_SOCK`) remain visible; do not export long-lived secrets into the environment that runs io.
- IO loads `AGENTS.md`/`CLAUDE.md` and `.agents/skills` as project context when enabled; disable them with `io config set contextFiles off` and `io config set skills off`.
- Pi extensions, prompt templates, and MCP servers are not loaded.
- Provider credentials are not written by IO itself, but command output and session files can contain anything a command prints. `/debug` writes a transcript snapshot; review it before sharing.
- Session files are created and repaired with owner-only (`0600`) permissions; the data directory itself is `0700`.

## Development

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run test:smoke
npm start
```

Tests use the Pi SDK faux provider and do not require production credentials or network access. CI publishes a coverage report and enforces minimums of 80 % lines, 70 % branches, and 70 % functions.

The production build bundles the CLI with esbuild. This reduced the installed payload from a 158 MB `node_modules` tree to a roughly 15 MB `dist`; the current warm interactive startup is about 0.58 s. See [docs/performance.md](docs/performance.md) for measurements and methodology.

Project layout:

```text
src/cli.ts              argument parsing and command dispatch
src/main.ts             interactive and headless startup
src/session.ts          Pi AgentSession, Bash tool, permissions, context
src/providers.ts        supported providers and model selection
src/runtime.ts          authentication, availability, model catalogs
src/tui/                terminal application and components
src/config.ts           XDG paths and preferences
src/safety.ts           destructive-command rules
```

## Release

Releases use semantic version tags:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release workflow validates the tag against `package.json`, runs typecheck/tests/build/smoke tests, publishes the GitHub release, and dispatches `formula: io` plus the release version to `plakio/homebrew-tap` using `TAP_DISPATCH_TOKEN`. A separate notification workflow covers releases published manually outside the tag workflow. The tap's existing update workflow regenerates `Formula/io.rb`, installs it from source, and runs `brew test`.

Do not create a release tag until the application and distribution workflow have been verified.

## License

IO is released under the [MIT License](LICENSE), copyright (c) 2026 Oscar Hugo Paz.

Third-party licenses and redistribution constraints are documented in [docs/licensing.md](docs/licensing.md). The build generates and ships `THIRD_PARTY_NOTICES.txt` with the bundled dependencies. The Homebrew formula installs both files.

---

Developed and maintained by [Plak](https://github.com/plakio).
