# Performance

Measured for IO `0.1.18` on 2026-11-13; the 0.1.19 patch only changes TUI rendering after the external editor and test coverage. These numbers describe the built
application on the host below; they are not a comparison with other tools.

## Environment

- Linux `aarch64` (ARM64), kernel `7.0.0-1013-oracle`
- 4 vCPU, 23.4 GiB RAM
- Node.js `v26.13.1`
- esbuild `0.28.2`
- Production bundle built with `npm run build`
- No network requests were made during startup measurements (`PI_OFFLINE=1`).

## Methodology

Startup:

- `io --version` and `io --help`: spawn the built CLI and measure until the
  process exits.
- `io auth status`: same, but initializes the Pi model runtime and checks
  credentials locally.
- Interactive: allocate a pseudo-terminal, spawn `io`, and measure until the
  first frame containing `type /help for commands` appears. Then send `Ctrl+D`
  to exit.
- Warm runs use the normal OS page cache.
- Cold page-cache measurements require dropping caches as root and were not
  repeated for this run.

Idle memory:

- Spawn the interactive application in a pseudo-terminal.
- Wait until the first rendered frame, then wait one additional second with no
  model request.
- Read `VmRSS` from `/proc/<pid>/status`.
- 8 runs.

Streaming render cost:

- `npm run bench:render`
- Simulates a growing markdown response of 17,213 characters.
- Re-renders the assistant block at width 100 after each of 250 updates, without
  the normal 50 ms throttle. This is a deliberate worst case.

## Startup

Warm OS page cache:

| Command | Median | Min | Max | Runs |
| --- | ---: | ---: | ---: | ---: |
| `io --version` | 55.9 ms | 54.1 ms | 91.2 ms | 15 |
| `io --help` | 56.5 ms | 53.1 ms | 61.1 ms | 10 |
| `io auth status` | 523.2 ms | 500.7 ms | 632.9 ms | 8 |
| interactive to first frame | 600.0 ms | 581.3 ms | 716.1 ms | 8 |

The interactive number includes the Pi TUI, model runtime initialization, the
initial session, and the first footer render. It is expected to be slower than
the CLI commands.

## Memory

Idle resident set size (RSS), after the first frame and one second of
inactivity:

- Median: **128.3 MB**
- Min: 127.0 MB
- Max: 129.5 MB
- Runs: 8

This includes Node.js, the bundled Pi SDK, the agent session, and the TUI. It
does not include a model request or a loaded tool result.

## Streaming responsiveness

Synthetic worst-case assistant rendering:

| Metric | Value |
| --- | ---: |
| Response size | 17,213 characters |
| Updates | 250 |
| Render width | 100 columns |
| Median per update | 0.59 ms |
| p95 per update | 0.92 ms |
| Max per update | 19.21 ms |

The TUI throttles assistant text updates to 50 ms intervals and coalesces render
requests. Tool output updates are similarly bounded by the SDK and the render
loop. Input is handled by the focused editor independently of provider
streaming, so typing and cancellation remain available while a response is
arriving.

## Build size

The production build uses esbuild to produce a bundled `dist/`:

- `dist/`: approximately 15 MB (including `THIRD_PARTY_NOTICES.txt`)
- `THIRD_PARTY_NOTICES.txt`: approximately 188 KB
- `dist/cli.js`: approximately 16 KB
- Unbundled TypeScript build with production `node_modules`: approximately
  158 MB

The Homebrew formula installs only the bundle and `package.json`, not
`node_modules`.

## Reproducing

```bash
npm ci --ignore-scripts
npm run build
npm run test:smoke
npm run bench:render
```

For interactive timing, allocate a pseudo-terminal, spawn `io`, wait for the
first `type /help for commands` frame, then send `Ctrl+D`.

macOS and Linux x64 were not available on the measurement host. CI runs the test
suite on `macos-latest` and `ubuntu-latest`; performance numbers for those
platforms should be collected on real hardware before making platform-specific
claims.
