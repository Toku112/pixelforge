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

## D-004 — 2026-10-06 — Invert as the Phase 0 "test command" (revised 2026-10-07)

**Context:** Phase 0 exit criteria require undo/redo of a test command. CLAUDE.md forbids placeholder features.
**Decision:** Use a real command: Image > Adjustments > Invert (Ctrl/Cmd+I) on the active pixel layer. It exercises
tile-diff undo, the command registry and the multi-threaded WASM worker path. (The original plan also listed Flip
Canvas Horizontal/Vertical; those move to Phase 1 with the other Image Rotation commands, since flipping layers with
offsets and a canvas-aligned Background needs the general resampling path built there.)
**Behaviour notes:** Invert is greyed out in 32-bit documents: the reference app's list of adjustments supported for
32-bit images (Levels, Exposure, Hue/Saturation, Channel Mixer, Photo Filter) does not include it. Lab, Indexed,
Bitmap, Duotone and Multichannel behaviour is not yet verified and stays disabled until Phase 4.
**Consequences:** The menu item is visible and works in Phase 0, but its PLAN Part B item stays unticked until the full
Definition of Done (adjustment-layer variant, selections, all colour modes).

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
CLAUDE.md list for anything that ships. For Rust crates the shipped list plus Unicode-3.0 is allowed: it appears only
on `unicode-ident`, a compile-time helper of the bindings' procedural macros, and is a permissive notice-style licence.

## D-008 — 2026-10-06 — One tsconfig per architecture layer

**Context:** CLAUDE.md §3.1 requires `src/core` to have no DOM/browser dependencies and run in Node.
**Decision:** `tsconfig.core.json` compiles `src/core` with only the ECMAScript library (no DOM, no Node types), so any
browser API use fails `pnpm typecheck`. ESLint `no-restricted-imports` rules enforce the import direction between layers.

## D-009 — 2026-10-06 — Cross-origin isolation via a server middleware

**Context:** SharedArrayBuffer (threaded WASM, shared tile memory) requires COOP `same-origin` + COEP `require-corp`.
Vite's `server.headers` option leaves these headers off 304 Not Modified responses; WebKit then blocks module imports
inside workers. Chromium and Firefox tolerate it.
**Decision:** A small Vite plugin (`crossOriginIsolation()` in `vite.config.ts`) sets the headers on every dev and
preview response. `public/_headers` declares them for static hosts. E2E tests check fresh and 304 responses.
**Consequences:** Production hosting must send both headers on every response (README). With `require-corp`, any future
cross-origin resource (e.g. web fonts) must be served with CORS/CORP headers or proxied — handle when it comes up.

## D-010 — 2026-10-06 — 4 GiB maximum shared memory for the threaded WASM build

**Context:** Shared WebAssembly memory must declare a maximum size up front. rustc's default for threaded builds was
1 GiB, too small for decoding or filtering large 16-bit images in one piece.
**Decision:** Link the threaded build with `--max-memory=4294967296` (the wasm32 limit). The memory is reserved, not
committed, and was verified to instantiate in Chromium, Firefox and WebKit. Tile-based processing keeps actual use low.

## D-011 — 2026-10-06 — Own worker RPC helper

**Context:** Main thread ↔ worker calls need typed request/response messaging with zero-copy buffer transfer.
**Decision:** A ~150-line helper (`src/workers/rpc.ts`) instead of a dependency such as Comlink: typed proxies,
`transfer()` marking, immediate rejection once a worker fails or is terminated.

## D-012 — 2026-10-06 — Test harness pages and production-build E2E

**Context:** Engine pieces (workers, WASM, later the compositor) need browser tests before the full UI exists, and
bundling can behave differently from the dev server.
**Decision:** Test-only pages live in `tests/e2e/harness/` (served by the dev server; added to a build only with
`PF_E2E_BUILD=1`). `pnpm test:e2e:preview` runs the whole E2E suite against a production build;
`pnpm test:e2e:all` adds Firefox and WebKit.

## D-013 — 2026-10-06 — Document model storage choices

**Context:** The tiled document model (PLAN Phase 0) fixes formats every later feature builds on.
**Decision:**

- Interleaved samples per tile (colour channels, then alpha) rather than planar channels: simpler compositing and GPU
  upload. Layer masks and alpha channels will be separate single-channel buffers.
- Straight (non-premultiplied) alpha in storage, as in PSD; premultiplication happens only inside the compositor.
- Copy-on-write via a one-way "frozen" flag instead of reference counting: a frozen tile is never written again, which
  is simple and always safe; at worst a tile is copied once more than strictly necessary.
- Unallocated tiles read as a per-buffer default pixel, so a new white Background costs no memory until painted.
- Integer per-layer offsets, so whole-pixel moves don't rewrite tiles.
- CMYK samples are ink amounts (0 = no ink); PSD's inverted storage is converted on I/O.
- The class is named `ImageDocument` to avoid shadowing the DOM's global `Document` type in UI code.

## D-014 — 2026-10-07 — History model: command undo + snapshot for the initial state

**Context:** History must be command-based with tile-diff undo (CLAUDE.md §3.2), but when the state limit drops the
oldest commands, the reference app still lets the user return to the opened state and back.
**Decision:** Entries are [initial snapshot, command 1 … n]. Moving between entries undoes/redoes commands. After the
oldest commands are dropped, jumping to the initial entry restores a captured document state (cheap: layer buffers
share frozen tiles); before doing so the current state is saved as an anchor, so later entries stay reachable. Undo
stops at the oldest kept command, as in the reference app. Commands refer to layers by id (never by object), so
they stay valid after a snapshot restore. All history operations are queued, so an undo pressed while an
asynchronous command runs waits for it.

## D-015 — 2026-10-07 — Tile store: what may be evicted to the scratch disk

**Context:** CLAUDE.md §3.3 asks for a memory budget with OPFS eviction. If any tile could be evicted, every pixel
access in the app (rendering, painting, eyedropper, export) would have to become asynchronous.
**Decision:** Tiles track how many buffers of open documents hold them (`attachedRefs`). Only frozen tiles that no
open document holds — undo data and history snapshots — are evicted, oldest first, to the OPFS scratch disk (one
file per tile size, fixed slots, per-tab session folders guarded by Web Locks, stale folders deleted at start-up). The
history calls `ensureResident` before undo/redo/snapshot restores. Tile memory is SharedArrayBuffer when the page is
cross-origin isolated. Default budget: 60 % of `navigator.deviceMemory` (4 GB assumed when the browser does not
report it).
**Consequences:** All live-document access stays synchronous and fast. Documents whose live tiles exceed memory are
not yet handled (KNOWN_GAPS; PLAN B25). Without OPFS (private windows), nothing is evicted.
