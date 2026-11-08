# Licensing

The final IO project license has **not** been selected. No `LICENSE` file is present, and nothing in this document should be read as choosing one.

## What IO depends on

Direct runtime dependencies, all pinned to the Pi SDK `1.5.0` line:

| Package | Version | License | Notes |
| --- | --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 1.5.0 | MIT | Agent sessions, Bash tool, settings, session storage |
| `@earendil-works/pi-ai` | 1.5.0 | MIT | Models, providers, credentials, streaming |
| `@earendil-works/pi-tui` | 1.5.0 | MIT | Terminal components and differential renderer |

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

The Homebrew formula installs `dist/`, so `THIRD_PARTY_NOTICES.txt` is installed with the application. CI's smoke test fails if the notices file is missing, empty, or still contains unresolved packages.

At the pinned dependency versions, no `NOTICE` files were present inside the installed packages. The collector copies any future `NOTICE` files automatically.

## Constraints for the final project license

The dependency set is permissive: MIT, Apache-2.0, BSD-3-Clause, ISC, BlueOak-1.0.0, 0BSD, and Unlicense. There is no copyleft runtime dependency in the current tree.

Apache-2.0 is compatible with many licenses, but it is **not** compatible with GPLv2-only terms. If the project chooses GPLv2-only, the bundled Apache-2.0 components create a conflict. If the project chooses MIT, Apache-2.0, BSD, ISC, or a compatible copyleft license such as GPLv3, the current tree can be redistributed with the generated notices.

The Pi SDK is MIT and permits use, modification, sublicensing, and redistribution provided its copyright and permission notice are preserved.

## Before a production release

- Decide the IO project license.
- If the decision requires a `LICENSE` file, add it then; do not add one preemptively.
- Confirm that `dist/THIRD_PARTY_NOTICES.txt` is generated with no unresolved packages.
- Re-run the dependency license inventory after any SDK or package update.
- Do not describe IO as MIT, Apache-2.0, or any other license until the decision is recorded.
