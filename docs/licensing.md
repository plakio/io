# Licensing

IO is released under the **MIT License**, copyright (c) 2026 Oscar Hugo Paz. The full text is in the repository's [`LICENSE`](../LICENSE) file.

The dependency set is permissive and compatible with MIT. This document records the dependency licenses and the notices that accompany the bundled build.

## What IO depends on

Runtime dependencies:

| Package | License | Notes |
| --- | --- | --- |
| `@opencode/sdk` | MIT | Embedded OpenCode host |
| `@opencode/plugin` | MIT | Server plugin API used by the io shell |
| `@opentui/core` | MIT | Terminal renderer and components |

The build also bundles transitive OpenCode packages (`@opencode/core`, `@opencode/server`, `@opencode/client`, `@opencode/schema`, `@opencode/ai`, `@opencode/protocol`, `@opencode/plugin`, `@opencode/util`, `@opencode/pty`) and OpenTUI native assets. All are MIT unless the generated notices say otherwise.

Notable transitive licenses include:

| License | Examples |
| --- | --- |
| MIT | Effect, OpenTUI, many OpenCode packages |
| Apache-2.0 | AWS SDK, OpenTelemetry, some provider SDKs |
| BSD-3-Clause | `diff`, `highlight.js`, `protobufjs` |
| ISC / BlueOak / 0BSD / Unlicense | utility packages |
| CC-BY-3.0 | `spdx-exceptions` (fallback text in `LICENSES/`) |
| CC0-1.0 | `spdx-license-ids` (fallback text in `LICENSES/`) |

Build-only dependencies: TypeScript, tsx, `@types/node`.

Bun is the runtime used by the compiled binary; Homebrew installs it as a build dependency when building from source.

## Redistribution

The production build is `dist-next/`: a Bun-compiled `io.bin`, the POSIX `io` wrapper, the OpenTUI native assets embedded in the executable, and the `@opencode/pty-<platform>` sidecar. `npm run build` runs `scripts/collect-licenses.mjs`, which:

- resolves the production dependency tree,
- copies license and notice texts into `dist-next/THIRD_PARTY_NOTICES.txt`,
- lists every package with its version, declared SPDX license, and repository,
- handles packages that declare a license but ship no file, including the SPDX fallbacks,
- groups packages with an identical license file under one text.

CI's smoke test fails if the notices file is missing, empty, or still contains unresolved packages.

## Compatibility

The dependency set is permissive: MIT, Apache-2.0, BSD-3-Clause, ISC, BlueOak-1.0.0, 0BSD, Unlicense, CC-BY-3.0, and CC0-1.0. There is no copyleft runtime dependency in the current tree. MIT is compatible with all of them.

Apache-2.0 dependencies require their license and any `NOTICE` text to be preserved. The generated notices include the Apache-2.0 license text. The collector copies `NOTICE` files automatically when present.

## Release checklist

- Keep the root `LICENSE` file and `package.json` license synchronized with the project decision.
- Keep the Homebrew formula's `license "MIT"` declaration and its `LICENSE` installation.
- Confirm that `dist-next/THIRD_PARTY_NOTICES.txt` is generated with no unresolved packages.
- Re-run the dependency license inventory after any SDK or package update.
- Do not change the project license without reviewing the full dependency inventory again.
