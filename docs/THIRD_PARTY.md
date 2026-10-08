# Third-party components

Every dependency and every ML model must be listed here with its licence (CLAUDE.md §1.1).

**Licence policy**

- Shipped in the app: MIT, BSD-2/3-Clause, Apache-2.0, ISC, Zlib, MPL-2.0 (as a separate module), 0BSD.
- Build/test tooling only (never bundled): the above plus BlueOak-1.0.0, CC-BY-4.0, CC0-1.0, Python-2.0 — see DECISIONS.md D-007.
- Anything else (GPL, AGPL, non-commercial, unknown) requires the owner's approval first.
- `pnpm check:licenses` (part of `pnpm lint` and CI) verifies every installed npm package, including transitive ones.

## Shipped (runtime) — npm

| Package   | Licence      | Purpose                                                    |
| --------- | ------------ | ---------------------------------------------------------- |
| react     | MIT          | UI shell (panels, menus, dialogs)                          |
| react-dom | MIT          | React DOM renderer                                         |
| zustand   | MIT          | UI state stores                                            |
| ag-psd    | MIT          | Reading and writing PSD/PSB files; reading ABR brush files |
| pako      | MIT AND Zlib | Deflate for ag-psd (ZIP-compressed PSD data)               |
| base64-js | MIT          | Used by ag-psd                                             |

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
| pngjs, @types/pngjs                         | MIT        | Independent PNG reader/writer for test images   |

Notable transitive tooling licences (build-time only): `lightningcss` (MPL-2.0, CSS processing inside Vite),
`minimatch` (BlueOak-1.0.0), `caniuse-lite` (CC-BY-4.0, browser-support data).

## Rust crates (WebAssembly)

Direct dependencies of the crates in `src/wasm/` (all compiled into the shipped `.wasm`):

| Crate                | Licence                   | Purpose                                                                                                                    |
| -------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| wasm-bindgen         | MIT OR Apache-2.0         | Rust ↔ JavaScript bindings                                                                                                 |
| rayon                | MIT OR Apache-2.0         | Data-parallel loops (threaded build only)                                                                                  |
| wasm-bindgen-rayon   | Apache-2.0                | Runs the rayon pool on Web Workers (threaded build only); its `workerHelpers.js` is bundled with its licence header intact |
| png                  | MIT OR Apache-2.0         | PNG decoding and encoding (`codecs` crate)                                                                                 |
| zune-jpeg, zune-core | MIT OR Apache-2.0 OR Zlib | JPEG decoding (`codecs` crate)                                                                                             |
| image-webp           | MIT OR Apache-2.0         | WebP decoding and lossless encoding (`codecs` crate)                                                                       |

Transitive crates (checked automatically by `pnpm check:licenses`): adler2, bitflags, byteorder-lite (MIT OR
Unlicense), crc32fast, fdeflate, flate2, miniz_oxide, quick-error, simd-adler32, bumpalo, cfg-if, crossbeam-\*, either,
futures-core/task/util, js-sys, once_cell, pin-project-lite, proc-macro2, quote, rayon-core, rustversion, slab, syn,
wasm-bindgen-macro/-macro-support/-shared, wasm_sync, web-sys — all MIT and/or Apache-2.0 — and unicode-ident
(`(MIT OR Apache-2.0) AND Unicode-3.0`, compile-time only).

Build tools (not shipped): wasm-pack (MIT OR Apache-2.0) downloads `wasm-bindgen-cli` (MIT OR Apache-2.0) and
binaryen's `wasm-opt` (Apache-2.0) into its own cache.

JPEG encoding is our own code (`codecs/src/jpeg_encode.rs`, written from ITU-T T.81), so no JPEG encoder library is
used. Lossy WebP is encoded by the browser's built-in encoder (owner-approved, D-034).

## ML models

_None yet._

## Fonts, icons, presets, sample images

_None yet. All icons, presets and sample images are created by us (CLAUDE.md §1.1)._
