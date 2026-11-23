# Performance

Measured for IO `0.2.0` on 2026-11-22. These numbers describe the OpenTUI/OpenCode build on the host below; they are not a comparison with other tools.

## Environment

- Linux `aarch64` (ARM64), kernel `7.0.0-1013-oracle`
- 4 vCPU, 23.4 GiB RAM
- Bun `1.4.5` compiled binary
- Build: `npm run build` (`scripts/build-next.mjs`)

## Artifact

- `dist-next/io.bin`: 142.7 MB
- `node_modules/@opencode/pty-linux-arm64-gnu`: 3.1 MB sidecar
- `dist-next/THIRD_PARTY_NOTICES.txt`: 354 packages, 170 license texts

The binary embeds OpenTUI's native library and assets. The PTY sidecar stays available through the wrapper's `NODE_PATH`.

## Startup

`./dist-next/io --version` exits in about **0.50 s** with a peak RSS of about **138 MB**, measured with `/usr/bin/time -f '%e %M'`.

The interactive TUI was launched under a pseudo-TTY from a different working directory to verify the wrapper and sidecar; a full interactive latency benchmark is still pending.

## Streaming

Token/context/cost figures come from OpenCode session usage events, not estimates. The transcript renders text deltas and tool events as they arrive.
