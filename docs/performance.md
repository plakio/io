# Performance

Measured for IO `0.1.0` on 2026-11-07. The `0.1.1` patch changes footer rendering only; the measured startup, memory, and streaming paths are unchanged. The goal is to report what the built application actually does, not to compare it with other tools.

## Environment

- Linux `aarch64` (ARM64), kernel `7.0.0-1013-oracle`
- 4 vCPU, 23.4 GiB RAM
- Node.js `v26.13.0`
- esbuild `0.28.2`
- Production bundle built with `npm run build`
- No network requests were made during startup measurements.

## Methodology

Startup:

- `io --version` and `io --help`: spawn the built CLI and measure until the process exits.
- `io auth status`: same, but initializes the Pi model runtime and checks credentials locally.
- Interactive: allocate a pseudo-terminal, spawn `io`, and measure until the first frame containing the `ready` footer appears. Then send `/quit`.
- Warm runs use the normal OS page cache.
- Cold runs run `sync` and drop clean page cache (`/proc/sys/vm/drop_caches`) before each launch. These numbers are disk-bound and are not the normal repeat-launch experience.

Idle memory:

- Spawn the interactive application in a pseudo-terminal.
- Wait until the first `ready` frame, then wait one additional second with no model request.
- Read `VmRSS` from `/proc/<pid>/status`.
- 10 runs.

Streaming render cost:

- `npm run bench:render`
- Simulates a growing markdown response of 17,213 characters.
- Re-renders the assistant block at width 100 after each of 250 updates, without the normal 50 ms throttle. This is a deliberate worst case.

## Startup

Warm OS page cache:

| Command | Median | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| `io --version` | 52.3 ms | 50.8 ms | 57.8 ms | 15 |
| `io --help` | 54.6 ms | 50.6 ms | 55.4 ms | 10 |
| `io auth status` | 491.8 ms | 485.9 ms | 517.6 ms | 8 |
| interactive to first frame | 500.4 ms | 487.2 ms | 518.1 ms | 8 |

Cold page cache (after dropping caches):

| Command | Median | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| `io --version` | 2403.6 ms | 690.5 ms | 3383.1 ms | 5 |
| interactive to first frame | 3364.6 ms | 3108.8 ms | 3756.3 ms | 5 |

The Homebrew-installed `io` wrapper (a Bash `exec` around Node) measured 53.2 ms for `--version`, 501.6 ms to the first interactive frame, and 126.8 MB idle RSS across 5-10 runs. The wrapper overhead is negligible.

The cold numbers are dominated by reading the Node.js runtime and the bundle from disk. They varied widely between runs, which suggests that dropping page cache did not fully isolate the storage path on this host. Treat them as a storage-bound upper bound, not as the normal repeat-launch experience.

## Memory

Idle resident set size (RSS), after the first frame and one second of inactivity:

- Median: **127.1 MB**
- Min: 126.7 MB
- Max: 127.7 MB
- Runs: 8

This includes Node.js, the bundled Pi SDK, the agent session, and the TUI. It does not include a model request or a loaded tool result.

## Streaming responsiveness

Synthetic worst-case assistant rendering:

| Metric | Value |
| --- | ---: |
| Response size | 17,213 characters |
| Updates | 250 |
| Render width | 100 columns |
| Median per update | 0.60 ms |
| p95 per update | 0.95 ms |
| Max per update | 19.01 ms |

The TUI throttles assistant text updates to 50 ms intervals and coalesces render requests. Tool output updates are similarly bounded by the SDK and the render loop. Input is handled by the focused editor independently of provider streaming, so typing and cancellation remain available while a response is arriving.

## Build size

The production build uses esbuild to produce a bundled `dist/`:

- `dist/`: approximately 14 MB (including `THIRD_PARTY_NOTICES.txt`); Homebrew reports 14.4 MB installed
- Unbundled TypeScript build with production `node_modules`: approximately 158 MB

The Homebrew formula installs only the bundle and `package.json`, not `node_modules`. The measured warm interactive startup for the unbundled `tsc` build was about 1.06 s; the bundled build was about 0.50 s.

## Reproducing

```bash
npm ci --ignore-scripts
npm run build
npm run test:smoke
npm run bench:render
```

For interactive timing, use any pseudo-terminal driver (for example Python's `pty` module) and measure from process spawn until the footer contains `ready`.

macOS and Linux x64 were not available on the measurement host. CI runs the test suite on `macos-latest` and `ubuntu-latest`; performance numbers for those platforms should be collected on real hardware before making platform-specific claims.
