# Decisions log

Non-obvious decisions (algorithm choices, deviations from the reference behaviour, tooling choices).
Newest at the bottom. Format: ID — date — title, then context, decision, consequences.

---

## D-001 — 2026-10-06 — TypeScript 6.0 instead of 7.0

**Context:** TypeScript 7.0 (native compiler) is the latest release, but `typescript-eslint` (needed for type-aware lint
rules such as no-floating-promises) supports only TypeScript `<6.1`.
**Decision:** Pin TypeScript `~6.0`. Same language and strictness settings.
**Consequences:** Revisit when `typescript-eslint` supports 7.x (faster typechecks).

## D-002 — 2026-10-06 — Pure-Rust image codecs instead of C libraries (owner-approved)

**Context:** CLAUDE.md §2 lists libpng/libjpeg-turbo/libwebp compiled to WASM. Compiling C libraries requires the
Emscripten toolchain. Browser-native decoding (`createImageBitmap`) is unacceptable for a pro editor: it drops 16-bit
precision, premultiplies alpha and applies colour conversion.
**Decision:** For PNG/JPEG/WebP use permissively licensed pure-Rust decoders (e.g. `png`, `zune-jpeg`, `image-webp`)
inside our own Rust → WASM crate. Approved by the owner on 2026-10-06.
**Consequences:** One toolchain (rustup + wasm-pack); memory-safe parsing of untrusted files; full 16-bit PNG support.
C libraries (lcms2, libjxl, libavif, LibRaw, OpenEXR…) will still need Emscripten or clang+wasi-sdk — ask the owner
before Phase 7.

## D-003 — 2026-10-06 — Pinned nightly Rust for WASM threads (owner-approved)

**Context:** Multi-threaded WebAssembly (shared memory + atomics) on `wasm32-unknown-unknown` requires rebuilding the
Rust standard library with atomics enabled, which is only possible on the nightly toolchain.
**Decision:** The WASM crates use a pinned, dated nightly (`nightly-2026-10-01`, set in `src/wasm/rust-toolchain.toml`)
with SIMD (`simd128`) and threads. A single-threaded SIMD build is used as a fallback when the page is not
cross-origin isolated. Approved by the owner on 2026-10-06.
**Consequences:** Updating the nightly is a deliberate, tested change (update the pin, rebuild, run all tests).

## D-004 — 2026-10-06 — Real commands as the Phase 0 "test command"

**Context:** Phase 0 exit criteria require undo/redo of a test command. CLAUDE.md forbids placeholder features.
**Decision:** Use real commands: Image > Adjustments > Invert (Ctrl/Cmd+I) on the active pixel layer (exercises tile-diff
undo and the WASM worker path), and Image > Image Rotation > Flip Canvas Horizontal/Vertical.
**Consequences:** These menu items are visible and work in Phase 0, but their PLAN Part B items stay unticked until they
meet the full Definition of Done (adjustment-layer variant, selections, all colour modes).

## D-005 — 2026-10-06 — Own docking-panel framework

**Context:** Existing React docking libraries are designed for IDE-style split layouts and do not model the reference
app's dock semantics (columns of stacked tab groups, collapse to icon strips, floating groups, saved workspaces).
**Decision:** Implement our own serialisable dock layout model + React renderer under `src/ui/dock/`.
**Consequences:** More code to own, but full control over behaviour and workspace persistence. No extra dependency.

## D-006 — 2026-10-06 — Definition of Done for infrastructure tasks

**Context:** CLAUDE.md §5 is written for user-facing features (colour modes, shortcuts, PSD round trip).
**Decision:** For infrastructure tasks (tooling, tile store, compositor, shell) the applicable DoD items are enforced
(bit depths where relevant, undoable where it mutates a document, tests, performance, no console errors/leaks); the
others are N/A and stated in the PLAN note or commit message.

## D-007 — 2026-10-06 — Extra permissive licences for build-time tooling only

**Context:** Vite/ESLint pull in transitive packages under BlueOak-1.0.0 (`minimatch`), CC-BY-4.0 (`caniuse-lite`
browser data), CC0-1.0 and Python-2.0. None are GPL/AGPL/non-commercial and none are bundled into the app.
**Decision:** Allow these licences for development tooling only. `scripts/check-licenses.ts` enforces the stricter
CLAUDE.md list for anything that ships.

## D-008 — 2026-10-06 — One tsconfig per architecture layer

**Context:** CLAUDE.md §3.1 requires `src/core` to have no DOM/browser dependencies and run in Node.
**Decision:** `tsconfig.core.json` compiles `src/core` with only the ECMAScript library (no DOM, no Node types), so any
browser API use fails `pnpm typecheck`. ESLint `no-restricted-imports` rules enforce the import direction between layers.
