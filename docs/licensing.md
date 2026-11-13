# Licensing

IO is released under the **MIT License**, copyright (c) 2026 Oscar Hugo Paz. The full text is in the repository's [`LICENSE`](../LICENSE) file.

The dependency set is permissive and compatible with MIT. This document records the dependency licenses and the notices that accompany the bundled build.

## What IO depends on

Direct runtime dependencies, all pinned to the Pi SDK `1.5.2` line:

| Package | Version | License | Notes |
| --- | --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 1.5.2 | MIT | Agent sessions, Bash tool, settings, session storage |
| `@earendil-works/pi-ai` | 1.5.2 | MIT | Models, providers, credentials, streaming |
| `@earendil-works/pi-tui` | 1.5.2 | MIT | Terminal components and differential renderer |

The Pi SDK's upstream license is MIT, copyright (c) 2025 Mario Zechner. The upstream license text is kept in [`LICENSES/pi-MIT.txt`](../LICENSES/pi-MIT.txt). The published npm packages do not include a separate `LICENSE` file, so this copy is used when the build generates notices.

Notable transitive runtime packages:

| Package | License |
| --- | --- |
| `@anthropic-ai/sdk` | MIT |
| `openai` | Apache-2.0 |
| `@google/genai` | Apache-2.0 |
| `@aws-sdk/*`, `@smithy/*` | Apache-2.0 |
| `@silvia-odwyer/photon-node` | Apache-2.0 |
| `grok-mermaid` | Apache-2.0 |
| `diff` | BSD-3-Clause |
| `highlight.js` | BSD-3-Clause |
| `protobufjs` | BSD-3-Clause |
| `yaml` | ISC |
| `minimatch` | BlueOak-1.0.0 |
| `tslib` | 0BSD |
| `fast-sha256` | Unlicense |

Build-only dependencies:

| Package | License |
| --- | --- |
| `typescript` | Apache-2.0 |
| `esbuild` | MIT |
| `tsx` | MIT |
| `@types/node` | MIT |

Node.js is a runtime dependency of the Homebrew formula. It is not bundled into IO's `dist/`. Node.js is distributed under the MIT license and its own third-party notices.

## Redistribution

The production build is a single bundled `dist/` directory. It contains code from the dependencies above, so the distribution must preserve their license and notice terms. `npm run build` runs `scripts/collect-licenses.mjs`, which:

- resolves the production dependency tree,
- copies license and notice texts into `dist/THIRD_PARTY_NOTICES.txt`,
- lists every package with its version, declared SPDX license, and repository,
- falls back to the Pi SDK MIT text when a Pi package ships no license file,
- groups packages with an identical license file under one text.

The Homebrew formula installs `dist/`, `package.json`, and `LICENSE`, so the IO license and `THIRD_PARTY_NOTICES.txt` are installed with the application. CI's smoke test fails if the notices file is missing, empty, or still contains unresolved packages.

At the pinned dependency versions, no `NOTICE` files were present inside the installed packages. The collector copies any future `NOTICE` files automatically.

## Compatibility

The dependency set is permissive: MIT, Apache-2.0, BSD-3-Clause, ISC, BlueOak-1.0.0, 0BSD, and Unlicense. There is no copyleft runtime dependency in the current tree. MIT is compatible with all of them.

The Pi SDK is MIT and permits use, modification, sublicensing, and redistribution provided its copyright and permission notice are preserved. Those notices are included in the generated third-party notices.

Apache-2.0 dependencies require their license and any `NOTICE` text to be preserved. The generated notices include the Apache-2.0 license text. No `NOTICE` files were present in the pinned packages; the collector copies them automatically if a future version adds one.

## Release checklist

- Keep the root `LICENSE` file and `package.json` license synchronized with the project decision.
- Keep the Homebrew formula's `license "MIT"` declaration and its `LICENSE` installation.
- Confirm that `dist/THIRD_PARTY_NOTICES.txt` is generated with no unresolved packages.
- Re-run the dependency license inventory after any SDK or package update.
- Do not change the project license without reviewing the full dependency inventory again.
