# io

IO is a minimal AI harness for the terminal, developed and maintained by [Plak](https://github.com/plakio). It gives the model a Bash shell and keeps everything else small: a keyboard-first [OpenTUI](https://opentui.com) interface, persistent sessions, real token accounting, and the embedded [OpenCode](https://opencode.ai) engine underneath.

IO is not only a coding agent. It is useful for programming, file manipulation, system administration, repository work, research with standard command-line utilities, and automation.

## Philosophy

> Give the model a shell and keep everything else simple.

There is no MCP integration, plugin marketplace, browser automation, or large custom tool collection. The model uses `bash`, `git`, `rg`, `find`, `sed`, `awk`, `curl`, `jq`, and the rest of the Unix toolbox.

The shell runs with your user permissions. IO's permission rules are a speed bump for mistakes, **not a sandbox**: see [Security](#security).

## Requirements

- macOS ARM64/x64 or Linux ARM64/x64.
- Bun 1.3.14+ to run the distributed binary, or Node.js 26.4+ with `--experimental-ffi` to run the source.
- Git for `/diff` and git workflows.

## Installation

```bash
brew install plakio/tap/io
```

From source:

```bash
git clone git@github.com:plakio/io.git
cd io
npm ci --ignore-scripts
npm run build
./dist-next/io
```

`npm run build` produces a Bun-compiled binary in `dist-next/`. The artifact contains OpenTUI's native library and needs the adjacent `node_modules/@opencode/pty-*` sidecar; the `dist-next/io` wrapper sets `NODE_PATH` automatically.

## Authentication

```bash
io auth status
io auth login opencode-go
io auth login 50x
io auth logout opencode-go
io auth import
```

Inside the TUI, `/connect` is the single authentication entry point: it lists providers, starts OAuth, stores API keys and removes credentials. There is no separate `/login` or `/logout`. The CLI commands above remain available for scripts.

`auth login` uses OpenCode integrations: OAuth providers open the provider browser/device flow, and key providers fall back to an API-key prompt. `auth import` copies API keys from the previous Pi `auth.json`; OAuth credentials should be connected with `auth login`.

Credentials live in OpenCode's credential store, not in `config.json`.

### OpenAI-compatible providers

`models.json` keeps the Pi-compatible shape. At startup, IO converts it to OpenCode's provider config under `~/.config/io/opencode/opencode.json`:

```json
{
  "providers": {
    "50x": {
      "name": "50x",
      "baseUrl": "https://api.ai.50x.energy/v1",
      "api": "openai-completions",
      "apiKey": "$FIFTYX_API_KEY",
      "models": [
        {
          "id": "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          "name": "DeepSeek V4.1 Flash",
          "reasoning": true,
          "contextWindow": 1000000,
          "maxTokens": 384000
        }
      ]
    }
  }
}
```

Prefer `$NAME`/`${NAME}` environment interpolation over literal keys: `models.json` itself is readable by the agent's shell, while referenced environment variables are stripped from Bash commands.

## Models

```bash
io models                       # authenticated models
io models opencode-go           # one provider
io models --json                # machine-readable
io --model opencode-go/glm-5.3  # one interactive run
```

Inside a session:

```text
/model                  pick from authenticated models
/model provider/model   select directly
```

The selected provider and model are persisted in `~/.config/io/config.json` (or `$XDG_CONFIG_HOME/io/config.json`). Model variants are selected with `Ctrl+T` in the picker.

## Usage

```bash
io
```

Start in the current working directory.

### Headless

```bash
io run "summarize this repository"
io run --continue "what changed?"
io run --session <id-prefix> "..."
io run -m opencode-go/glm-5.3 "..."
io run --mode auto "run the tests"
io run --stats "review this diff"
io run --fail-on-tool-error "deploy"
echo "explain this error" | io run
```

Headless runs write assistant text to stdout. Commands that need confirmation are denied; add a permission rule or use `--mode auto`. A completed turn exits 0, provider errors exit 1, and an interrupted run exits 130.

### Project context

IO loads:

- `AGENTS.md` (or `AGENTS.override.md`, `CLAUDE.md`) from the working directory and its ancestors.
- Skills from `~/.agents/skills` and `<project>/.agents/skills`.

Disable either source with `io config set contextFiles off` or `io config set skills off`.

Sessions compact their context automatically before the model window fills. Use `/compact` to force it.

### Sessions

```bash
io sessions                       # recent sessions
io sessions --json
io sessions prune                 # dry-run: older than 30 days
io sessions prune --older-than 7 --yes
io sessions import                # import Pi JSONL sessions
io sessions import --from <dir>
```

Session data lives in IO's OpenCode database under `~/.local/share/io` (or `$XDG_DATA_HOME/io`). Imported Pi sessions keep user/assistant text; tool results are not replayed.

## Keys

| Key | Action |
| --- | --- |
| `Enter` | Send prompt |
| `Shift+Enter` / `Ctrl+J` | Insert newline |
| `Esc` / `Ctrl+C` | Cancel generation or close overlay |
| `Ctrl+C` twice | Exit when the prompt is empty |
| `Ctrl+P` | Command palette |
| `Ctrl+X` then key | Leader actions |
| `Tab` | Complete a command |
| `Ctrl+O` | Expand or collapse tool output (leader `o`) |
| `Ctrl+T` | Cycle model variants |
| `Shift+Tab` | Cycle agents |
| `Ctrl+X b` | Toggle sidebar |
| `Ctrl+X g` | Session timeline |
| `Ctrl+X s` | Status |
| `Ctrl+X u` / `r` | Undo / redo message |
| `Ctrl+X y` | Copy last message |
| `Ctrl+X e` | Edit prompt in `$EDITOR` |
| `Ctrl+X j` / `k` | Stash / restore draft |
| `Ctrl+X ↓` / `↑` | Subagents / parent session |
| `Ctrl+1…9` | Switch session tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous session tab |
| `Tab` | Complete a command or `@file` |
| `Esc` twice | Interrupt a running turn |

Leader actions include `m` models, `a` agents, `l` sessions, `n` new session, `c` compact, `d` diff, `q` queue, `s` status, `g` timeline, `u`/`r` undo/redo, `y` copy, `e` editor, `j`/`k` stash, `t` thinking, `v` verbosity, `p` tokens/second, `h` theme. `Ctrl+Alt+K` shows all bindings.

Tabs can be switched by clicking them; the `×` closes the tab without deleting the session.

Typing `/` opens the command menu with descriptions. Typing `@` completes workspace paths. Selecting a model with reasoning variants opens the effort step (`Default`, `low`, `medium`, `high`, …).

## Session commands

```text
/help            show commands and keys
/resume          resume a previous session
/update          check for and install io updates
/connect         connect or remove providers
/agents          list agents and subagents
/agent           select the primary agent
/models          list authenticated models
/model [ref]     select a model
/new             start a new session
/continue        continue the latest session
/cd [path]       show or change the working directory
/status          session, model, context and engine state
/timeline        jump to an earlier user message
/subagents       open a child session
/stash [list|pop|clear]  stash or restore prompt drafts
/error           show the last error in full
/copy [id]       copy the last message or session ID
/export [path]   export the session to Markdown
/edit            edit the prompt in $EDITOR
/undo, /redo     revert or restore messages
/compact         compact context
/diff [path]     show git changes
/queue           manage queued prompts
/quit, /q        exit
```

## Agents

io registers OpenCode's built-in agents on the embedded host:

| Agent | Mode | Use |
| --- | --- | --- |
| `build` | primary | Default coding agent |
| `plan` | primary | Read-only exploration and planning |
| `general` | subagent | Multi-step research and parallel work |
| `explore` | subagent | Fast codebase search and reading |
| `compaction` | hidden | Context compaction |
| `title` | hidden | Automatic session titles |
| `summary` | hidden | Conversation summaries |

`/agent`, `Ctrl+X a` or `Shift+Tab` select a primary agent. `/agents` lists every agent, including subagents and hidden maintenance agents.

## Configuration

```bash
io config                  # show or edit preferences
io config show
io config edit
io config set provider opencode-go
io config set model opencode-go/deepseek-v4.1-flash
io config set mode auto
io config set theme dark
io config set tps off
io config set markdown source
```

Configuration lives in `~/.config/io/config.json`. Credentials are never stored there.

Appearance:

```json
{
  "appearance": {
    "theme": "io",
    "verbosity": "normal",
    "thinking": false,
    "tps": true,
    "markdown": "rendered",
    "toolOutput": "collapsed"
  }
}
```

Themes: `io`, `io-light`, `system`, `dark`, `light`. Verbosity: `low`, `normal`, `high`, `debug`.

Environment variables:

- `OPENCODE_API_KEY` — OpenCode Go API key.
- `AWS_BEARER_TOKEN_BEDROCK` — Amazon Bedrock bearer token.
- Any environment variable referenced as `$NAME` or `${NAME}` in `models.json`.
- `XDG_CONFIG_HOME`, `XDG_DATA_HOME` — standard directory overrides.
- `IO_CONFIG_DIR`, `IO_DATA_DIR` — IO-specific directory overrides.

## Security

See [SECURITY.md](SECURITY.md).

IO runs commands as your user, in your shell. The permission layer is a **speed bump for mistakes and a visibility aid, not a sandbox**.

- Every command is shown in the tool panel. With `verbosity low` the panel is hidden.
- Commands matching destructive patterns require approval; default is deny.
- `permissions` rules use the OpenCode V2 shape `{ action, resource, effect }`.
- Credential files (`.env`, `auth.json`, SSH private keys, cloud credentials) are denied.
- Provider environment variables are removed from the shell environment.
- Denied commands are reported to the model and are not executed.
- Running commands are cancelled through the engine's abort signal.
- The embedded host uses its own config directory and database under IO's XDG paths.

## Development

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:ui       # TUI tests on Node 26
npm run test:ui:bun   # TUI tests on Bun
npm run build
npm run test:smoke
npm start
```

Project layout:

```text
src/cli.ts                 argument parsing and command dispatch
src/commands/              models, sessions, run, auth, config, update
src/engine/                AgentEngine contract and OpenCode adapter
src/tui/next/              OpenTUI shell, transcript, composer and overlays
src/config.ts              XDG paths and preferences
src/safety.ts              destructive-command rules
```

## Release

Releases use semantic version tags:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release workflow validates the tag against `package.json`, runs typecheck/tests, builds the OpenTUI binary, runs the smoke test, publishes the GitHub release, and dispatches `formula: io` plus the release version to `plakio/homebrew-tap`.

## License

IO is released under the [MIT License](LICENSE), copyright (c) 2026 Oscar Hugo Paz.

Third-party licenses and redistribution constraints are documented in [docs/licensing.md](docs/licensing.md). The build generates and ships `THIRD_PARTY_NOTICES.txt` with the bundled dependencies.

---

Developed and maintained by [Plak](https://github.com/plakio).
