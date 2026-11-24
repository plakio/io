# Packaging the OpenTUI build

This document covers the `io` build that embeds **OpenCode** and **OpenTUI**. The Pi-based `dist/` build has been retired.

## Artifact

`npm run build:next` writes:

```text
dist-next/
  io                     POSIX wrapper; sets NODE_PATH and execs io.bin
  io.bin                 Bun-compiled executable
  io.cmd                 Windows wrapper; execs io.bin.exe
  io.bin.exe             Bun-compiled Windows executable
  node_modules/
    @opencode/pty-*/     native PTY sidecar required by OpenCode
  THIRD_PARTY_NOTICES.txt
  LICENSE
  README.next.md
```

The wrapper resolves its own symlink, points `NODE_PATH` at the adjacent `node_modules`, and runs `io.bin`. This is required because Bun resolves OpenCode's native PTY package from `NODE_PATH`, not from the executable directory.

## Runtime

- Bun 1.3.14+ to run the compiled binary.
- The binary embeds the OpenTUI native library and assets.
- Windows uses `io.cmd` + `io.bin.exe`; the embedded terminal currently requires `script` and is disabled there.
- OpenCode's PTY package remains a sidecar (`~3 MB`).
- Node.js 26.4+ with `--experimental-ffi` is only needed to run the TypeScript source, not the compiled binary.

## Build

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run build:next
```

Targets:

```bash
node scripts/build-next.mjs --target=bun-linux-arm64
node scripts/build-next.mjs --target=bun-linux-x64
node scripts/build-next.mjs --target=bun-darwin-arm64
node scripts/build-next.mjs --target=bun-darwin-x64
node scripts/build-next.mjs --target=win32-x64
node scripts/build-next.mjs --target=win32-arm64
```

Cross-target builds require the matching optional packages:

```bash
npm install --no-save @opentui/core-linux-x64 @opencode/pty-linux-x64-gnu
# Windows
npm install --no-save --force --os=win32 --cpu=x64 @opentui/core-win32-x64 @opencode/pty-win32-x64
```

`build:next` checks both before compiling. The current release matrix must be built on each target or with all optional packages installed.

## Build workarounds

1. **`ws` interop**: `scripts/patch-opencode-ws.mjs` patches
   `@effect/platform-node-shared/dist/NodeWS.js` for Bun's CJS/ESM re-export.
   The patch is idempotent and applied automatically by `build:next`.
2. **Claude Agent provider**: `build:next` installs a local
   `@anthropic-ai/claude-agent-sdk` stub when the real package is absent. io does
   not use that provider; the stub avoids pulling its ~394 MB dependency tree
   into the build.
3. **PTY sidecar**: `@opencode/pty-<platform>` is copied next to the binary.
   The wrapper exposes it through `NODE_PATH`.
4. **Version injection**: `IO_VERSION` is defined at compile time so
   `io --version` does not try to read a package.json from the Bun virtual FS.

## Licenses

`build:next` runs the notice collector with `IO_INCLUDE_DEV=1` because OpenCode
and OpenTUI are dev dependencies until the cutover. It also has fallback texts
for `spdx-exceptions` and `spdx-license-ids`, which declare licenses but do not
ship license files.

## Homebrew sketch

```ruby
class IoNext < Formula
  desc "Minimal AI coding harness with an OpenCode engine and OpenTUI"
  homepage "https://github.com/plakio/io"
  url "https://github.com/plakio/io/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "TODO"
  license "MIT"

  depends_on "node" => :build
  depends_on "bun" => :build

  def install
    system "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"
    system "npm", "run", "build:next"
    libexec.install Dir["dist-next/*"]
    bin.install_symlink libexec/"io"
  end

  test do
    assert_match "io ", shell_output("#{bin}/io --version")
  end
end
```

`libexec` keeps `io`, `io.bin` and the PTY sidecar together. The wrapper resolves
the `bin/io` symlink before setting `NODE_PATH`.

## Current verification

Build host: Linux arm64.

| Target | Binary | PTY sidecar | Toolchain output |
| --- | ---: | ---: | --- |
| Linux arm64 | 122.9–142.6 MB | 3.1 MB | ELF aarch64 |
| Linux x64 | 143.7 MB | 3.5 MB | ELF x86-64 |
| macOS arm64 | 131.6 MB | 2.6 MB | Mach-O arm64 |
| macOS x64 | 143.9 MB | 2.8 MB | Mach-O x86_64 |

- Cross builds compile successfully; smoke is skipped for non-host targets.
- Linux arm64 `dist-next/io --version`: `io 0.1.20`, ~0.50 s and ~138 MB max RSS.
- The TUI starts under a pseudo-TTY from a different working directory, proving
  the wrapper resolves the sidecar.
- Homebrew 7.0.15 local tap: `brew install --build-from-source` installed
  `io-next` (132.7 MB), `brew test` passed, and `io-next` started the TUI under a
  pseudo-TTY.
- `THIRD_PARTY_NOTICES.txt`: 406 packages (414 with cross-target optional
  packages), 186 license texts, no unresolved packages after the SPDX fallbacks.
- macOS targets and Linux x64 are configured but not built on this machine.

## Remaining before release

- Run the macOS and Linux x64 binaries on their real targets; this host can only
  verify their file formats and cross-compilation.
- Resolve Tree-sitter highlighting fallback.
- Build the release artifact from `src/cli.ts` (the Pi build has been retired).
