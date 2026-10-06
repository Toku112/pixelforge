# Third-party components

Every dependency and every ML model must be listed here with its licence (CLAUDE.md §1.1).

**Licence policy**

- Shipped in the app: MIT, BSD-2/3-Clause, Apache-2.0, ISC, Zlib, MPL-2.0 (as a separate module), 0BSD.
- Build/test tooling only (never bundled): the above plus BlueOak-1.0.0, CC-BY-4.0, CC0-1.0, Python-2.0 — see DECISIONS.md D-007.
- Anything else (GPL, AGPL, non-commercial, unknown) requires the owner's approval first.
- `pnpm check:licenses` (part of `pnpm lint` and CI) verifies every installed npm package, including transitive ones.

## Shipped (runtime) — npm

| Package   | Licence | Purpose                           |
| --------- | ------- | --------------------------------- |
| react     | MIT     | UI shell (panels, menus, dialogs) |
| react-dom | MIT     | React DOM renderer                |
| zustand   | MIT     | UI state stores                   |

## Build & test tooling — npm

| Package                                     | Licence    | Purpose                                         |
| ------------------------------------------- | ---------- | ----------------------------------------------- |
| vite                                        | MIT        | Dev server and bundler                          |
| @vitejs/plugin-react                        | MIT        | React support for Vite                          |
| typescript                                  | Apache-2.0 | Type checking                                   |
| @types/react, @types/react-dom, @types/node | MIT        | Type definitions                                |
| vitest                                      | MIT        | Unit and golden-image tests                     |
| @playwright/test                            | Apache-2.0 | End-to-end browser tests                        |
| eslint, @eslint/js                          | MIT        | Linting                                         |
| typescript-eslint                           | MIT        | TypeScript lint rules                           |
| eslint-plugin-react-hooks                   | MIT        | React hooks lint rules                          |
| eslint-plugin-react-refresh                 | MIT        | Fast-refresh lint rule                          |
| eslint-config-prettier                      | MIT        | Disables lint rules that conflict with Prettier |
| globals                                     | MIT        | Global variable lists for ESLint                |
| prettier                                    | MIT        | Code formatting                                 |
| husky                                       | MIT        | Git pre-commit hook                             |
| lint-staged                                 | MIT        | Runs lint/format on staged files                |

Notable transitive tooling licences (build-time only): `lightningcss` (MPL-2.0, CSS processing inside Vite),
`minimatch` (BlueOak-1.0.0), `caniuse-lite` (CC-BY-4.0, browser-support data).

## Rust crates (WebAssembly)

_None yet._

## ML models

_None yet._

## Fonts, icons, presets, sample images

_None yet. All icons, presets and sample images are created by us (CLAUDE.md §1.1)._
