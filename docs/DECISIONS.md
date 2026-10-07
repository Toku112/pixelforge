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

## D-016 — 2026-10-07 — Test image fixtures generated by us, JPEG/WebP via Chromium

**Context:** Codec tests need JPEG and WebP files, but the Rust JPEG encoder crate is licensed with the IJG licence
(outside our allowlist), and third-party sample images are not allowed.
**Decision:** `scripts/make-fixtures.ts` draws synthetic patterns: PNGs are written byte by byte by a small writer in the
script; JPEG and WebP are encoded by headless Chromium, and Chromium's own decode of each is stored as the expected
image. Our decoders must match it within the golden tolerance (ΔE00 average ≤ 1, maximum ≤ 3). An EXIF orientation
block is spliced into one JPEG to test rotation.

## D-017 — 2026-10-07 — GPU compositor design

**Context:** CLAUDE.md §3.4 requires GPU compositing of dirty tiles only, a mip pyramid, and 60 fps pan/zoom on a
50-layer 8000×6000 document.
**Decision:**

- Layer tiles become textures on demand, cached by tile identity and version: 8-bit as normalised, 16-bit as
  unsigned-integer, 32-bit as float textures, all read exactly with `texelFetch` (no filtering at document resolution).
- Composite tiles (256 × 256) are RGBA16F (RGBA8 fallback) holding premultiplied colour in the document's encoding;
  the Normal mode uses hardware blending `ONE, ONE_MINUS_SRC_ALPHA`. Isolated groups composite into temporary
  textures; Pass Through groups with opacity mix before/after via a shader.
- The pyramid: a level-L tile covers 256·2^L document pixels and is the 2×2 average of its four children, computed
  lazily. The display level is `floor(log2(1/zoom))`; textures are sampled nearest-neighbour at ≥ 100 % and bilinear
  below. Edits invalidate a tile and its ancestors; stale or coarser tiles are shown until refreshed.
- Work per frame is capped (count and ~8 ms of CPU time) so interaction stays smooth.
- Transparency checkerboard: 8 CSS-px squares in document space (they move and rotate with the image), white/light
  grey. Pixel grid: one device pixel wide, above 500 %.
  **Verification:** GPU composites match the CPU reference within half-float precision in Chromium, Firefox and WebKit;
  every displayed pixel matches the expected colour at 100 %, 90° rotation, 25 % (pyramid), 16-bit, 32-bit and
  grayscale. On the development machine's GPU the 50-layer test pans/zooms/rotates at a steady 60 fps with ≈ 0.1 ms of
  main-thread work per frame (`pnpm test:perf`; CI's software GPU only checks correctness).

## D-018 — 2026-10-07 — Zoom means device pixels; zoom steps

**Decision:** 100 % shows one image pixel per _physical_ screen pixel (as pro editors do on high-density displays), so
the view works in device pixels and the canvas backing store is sized by `devicePixelRatio`. Zoom In/Out step through
preset levels (…, 25 %, 33.33 %, 50 %, 66.67 %, 100 %, 200 %, …, 800 %, 1200 %, 1600 %, 2400 %, 3200 %, 4800 %, 6400 %,
9600 %, 12 800 %), with finer steps down to 0.1 %. Fit on Screen is not snapped to a preset.

## D-019 — 2026-10-07 — Navigation input

**Decision:**

- Wheel / two-finger scroll pans (Shift + wheel: horizontal); Alt/Option + wheel zooms around the pointer, as in the
  reference app. Ctrl + wheel also zooms, because browsers report trackpad pinch gestures as Ctrl + wheel; this
  differs from the reference app on Windows, where Ctrl + wheel scrolls horizontally.
- Space = temporary Hand; Ctrl/Cmd + Space = temporary Zoom (add Alt/Option to zoom out). Escape abandons a drag.
- Pan limits follow the reference app's default with Overscroll off: an unrotated document smaller than the window
  stays centred; a larger one pans until its edge meets the window edge. Rotated views pan freely while the view
  centre stays on the document. (The Overscroll preference arrives with Preferences, PLAN B21.)
- Gesture distances (click-vs-drag slop, scrubby-zoom rate) are measured in CSS pixels so they feel the same on
  high-density displays; zoom percentages stay in device pixels (D-018).

## D-020 — 2026-10-07 — Keymap design

**Decision:**

- Chords are stored platform-neutrally ("Mod" = Cmd/Ctrl, "Alt" = Option/Alt, literal "Ctrl" only where macOS uses
  Control); on Windows/Linux "Ctrl" folds into "Mod".
- Matching: letters follow the character typed (so shortcuts follow the keyboard layout, e.g. AZERTY's Z key undoes),
  falling back to the physical key when Option/Alt changes the character; digits and punctuation use the physical
  key. "+" is stored as "=" (same key).
- A chord bound in the keymap is always kept from the browser (no "Save page" dialog on Ctrl+S) even when its command
  is not available yet. Plain keys and text-editing chords (Ctrl/Cmd + Z, X, C, V, A, Y) are left to text fields.
- Tool keys are spring-loaded: a tap switches tools; holding ≥ 300 ms or using the tool while the key is down makes it
  temporary. Shift + letter cycles tools sharing the letter.
- The default table covers the reference app's default shortcuts, including commands not implemented yet (their keys
  do nothing until registered). A unit test checks it has no conflicting chords on either platform.

## D-021 — 2026-10-07 — App shell behaviour

**Decision:**

- Menus list the reference app's full structure as data, but only items whose command is implemented are shown;
  top-level menus with nothing available yet are shown dimmed so the menu bar keeps its familiar shape. The
  development flag `?flags=show-unimplemented` shows every item greyed out.
- Newly opened documents are fitted to the window but never enlarged beyond 100 %; View > Fit on Screen may enlarge.
- Save writes back to the opened PNG only when the document is still a single pixel layer (nothing would be lost);
  otherwise Save behaves as Save As. Save As currently offers PNG.
- The panel layout is kept in the browser's local storage (a per-user convenience); Window > Workspace > Reset
  Essentials restores the default.
- Store actions and component callbacks are declared as function-typed properties so they can be passed around
  safely; text fields show the live value except while the user is typing (no state syncing effects).

## D-022 — 2026-10-07 — Layer structure commands

**Decision:**

- Layer selection (which layers are selected/active) is not a history step, as in the reference app; structure
  commands remember the selection and restore it on undo.
- New layers go directly above the active layer, or at the top inside the active group when that group is expanded
  (above it when collapsed) — the most common expectation; logged because the reference app's exact rule for groups
  could not be confirmed.
- Deleting selects the layer below the lowest deleted one; a document always keeps at least one layer; layers with
  "lock all" cannot be deleted.
- Undo data for structure changes are detached copies of the affected layers sharing frozen tiles (no pixel copies),
  re-inserted by id, so undo/redo stays correct after history snapshot restores.
- Converting the Background (Layer from Background, duplicating it) runs in the pixel worker: every allocated tile and
  every canvas tile gets an opaque alpha channel.

## D-023 — 2026-10-07 — Blend modes

**Decision:**

- All 27 layer blend modes plus Pass Through are implemented with the formulas in FORMAT_NOTES §3, identically in the
  CPU compositor (saving, merging, reference) and the GPU renderer (display).
- Fill acts inside the formula for the "special eight" modes by moving the layer colour towards the mode's neutral
  colour; for Hard Mix a lowered Fill turns the threshold into a contrast ramp. This reproduces the reference app's
  well-known behaviour (Fill and Opacity look different for these modes) but its exact internal formula is not
  published, so outputs may differ slightly from it at partial Fill until compared with real reference files.
- Dissolve uses a fixed hash of document coordinates, so the pattern is stable (the reference app's pattern is
  random-looking too but cannot be matched pixel for pixel).
- 32-bit documents offer the same reduced set of modes as the reference app and keep values above 1; Divide by black
  is capped at 65504 (the largest half-float) instead of producing infinity, and the whole-colour modes skip the
  upper clip so HDR highlights survive.
- The GPU keeps composites in half floats. Rather than doubling GPU memory with 32-bit float targets, we accept that
  pixels exactly on a mode's threshold can differ between display and saved file (tested limits in FORMAT_NOTES §3.9).
- CMYK display arrives with colour management (Phase 7); the CPU compositor already blends CMYK on inverted values.
- Shortcuts: Alt/Option + Shift + letter sets a mode and Shift + Plus/Minus cycles through the layer's menu (wrapping
  around; groups include Pass Through) on all selected layers that can change mode, as one history step. While typing
  in a text field these chords type characters instead. Once painting tools exist they will target the tool's mode
  while a painting tool is active, as in the reference app.
- Lock All now also fixes a layer's opacity, fill and blend mode, and Pass Through is refused for pixel layers.

## D-024 — 2026-10-07 — Layers panel

**Decision:**

- Thumbnails show the layer over the whole canvas (the reference app's default "Entire Document" contents), rendered
  in the pixel worker: each thumbnail pixel averages up to 4 × 4 samples of its footprint, which looks smooth at
  thumbnail size at a tiny fraction of the cost of averaging every pixel. They refresh one at a time after edits.
- Selecting layers and expanding/collapsing groups are view state and not history steps, as in the reference app.
  Visibility changes are history steps (as with its "make layer visibility changes undoable" History option on); the
  option to turn that off belongs with History Options.
- Dragging a value (Opacity/Fill labels) previews it live without recording; releasing records one step from the
  original value. Previews and commands run strictly one after another so rapid drags cannot lose the original.
- Deleting from the panel's button or the menus asks first ("Don't show again" is remembered in the browser, like the
  panel layout, until a Preferences dialog exists); Alt/Option-click skips the question, and Delete/Backspace in the
  focused layer list deletes without asking. For a group the question covers the group and its contents ("group
  only" is what Ungroup Layers does).
- A group's locks apply to everything inside it. The Background's locks are fixed.
- A New Layer / New Group from the dialog uses up the next number even when renamed, so later layers keep counting
  up. Group dialogs default to Pass Through.
- Renaming: double-click the name, Enter in the focused list, or Layer > Rename Layer…. (F2 is Cut in the default
  keymap.) Double-clicking the Background's name converts it to a normal layer through the New Layer dialog.
- The Essentials workspace now includes the Layers panel; panel layouts saved before this change are replaced by the
  new default once.

## D-025 — 2026-10-07 — Merging layers; long operations

**Decision:**

- Ctrl/Cmd+E does what fits the selection: Merge Down (one layer), Merge Layers (several), Merge Group (one group);
  the menu label follows.
- Merge Down keeps the lower layer's name, blend mode, opacity and fill and bakes the upper layer onto the lower
  layer's own pixels (so the result looks the same whenever the lower layer is Normal at 100 %). It needs a visible,
  editable pixel layer directly below in the same group; it is unavailable onto hidden or pixel-locked layers (the
  reference app's behaviour there could not be confirmed, and refusing is the safe choice).
- Merge Layers composites the selected layers on their own (Normal, 100 %), named after the topmost visible one and
  placed where it was; hidden selected layers are discarded; with the Background selected the result is the
  Background. Merge Group keeps the group's name, opacity and fill, and its blend mode (Pass Through → Normal).
- Merge Visible removes every visible layer (a group goes only when everything in it is visible) and puts the
  composite in the visible Background, or else a layer named after the active layer (if merged) or the topmost merged
  one, where the topmost merged layer was. Hidden layers stay where they are.
- Merged results keep pixels outside the canvas (union of the layers' bounds); Backgrounds and Stamp Visible are
  canvas-sized. Flatten Image composites over white and asks before discarding hidden layers. Background from Layer
  bakes the layer's opacity and fill over the fill colour; its blend mode does not apply (it has nothing to blend
  with but a plain colour).
- Long operations: commands get a task control; heavy work runs in chunks (rows of tiles) in the worker, reporting
  progress after each chunk and stopping at the next chunk boundary on Esc. The status bar shows the operation
  and a progress bar once it has run for 250 ms. A cancelled command leaves the document and the History unchanged.

## D-026 — 2026-10-07 — Selections

**Decision:**

- Selection masks are 8-bit in every document (as CLAUDE.md §3.1 allows); 16-bit precision for selections in 16-bit
  documents can come with channels (Phase 3) if banding in very soft feathers shows up.
- Feather radius r is a Gaussian blur with σ = r (the reference app's 10 px feather matches a 10 px Gaussian Blur of
  the mask, whose radius behaves like σ).
- Shapes use the even-odd fill rule (self-overlapping lassos leave holes) — the more common expectation; logged
  because the reference app's rule for crossing lassos could not be confirmed.
- Soft masks combine as fuzzy sets: Add = max, Intersect = min, Subtract = min(a, 255 − b).
- Every selection change is a history step named after the tool or command; a click that draws nothing (including
  inside the selection) deselects with New; pressing inside the selection with New and dragging moves the outline.
- Delete/Backspace is Edit > Clear: with a selection it clears the pixels (transparent, or the background colour on
  the Background or with locked transparency); without one it deletes the selected layers. The reference app opens
  the Fill dialog for Delete on the Background; that arrives with Edit > Fill.
- Modifier keys pressed or released during any drag take effect at once (no need to move the pointer).
- The marching-ants outline is traced in the worker and drawn on a 2D overlay above the WebGL canvas; the ants stand
  still when the user prefers reduced motion.
- Not in this item: Alt/Option temporarily switching the Lasso to straight segments (later, with the Magnetic Lasso in
  Phase 3), Select > Modify / Transform Selection (Phase 3), Hide Extras (View menu work).

## D-027 — 2026-10-07 — Foreground/background colours and the Color Picker

**Decision:**

- The swatch colours belong to the app (not a document) and are sRGB until colour management (Phase 7). Converting
  to a document: RGB as is (32-bit: linear light), Grayscale as the luma 0.299 R + 0.587 G + 0.114 B. Modes that need
  ICC conversions (CMYK, Lab, …) use white where a background colour is needed, until Phase 7.
- The Color Picker keeps hue, saturation and brightness as its state, so a grey or black keeps the hue it had; RGB,
  L*a*b* (D50) and hex fields follow and can be edited; out-of-gamut Lab values are clipped to sRGB.
- The picker's field always shows saturation × brightness for the current hue (the reference app's default);
  choosing another component for the field, web-safe colours, gamut warnings, swatches and colour libraries come
  with the full picker (Part B).
- The modal dialog frame no longer refocuses its first field on every re-render (it did so whenever a dialog's state
  changed); it keeps the latest cancel handler in a ref instead.

## D-028 — 2026-10-07 — Brush and Eraser

**Decision:**

- Strokes are painted live in the pixel worker: the tool turns pointer samples into dabs (spacing × diameter apart,
  carried over between pointer events), the paint session prepares the tiles they reach (copy-on-write, undo
  capture) and sends one batch at a time while later dabs queue, so painting never lags the pointer by more than a
  batch. The stroke then becomes one History step ("Brush Tool" / "Eraser") holding only the changed tiles; its
  descriptor (pointer samples, settings, colour samples) repaints it identically when replayed.
- Opacity caps a stroke and Flow builds up within it: per pixel the stroke keeps a coverage c ← c + (1 − c)·flow·
  profile, and the pixel is recomputed from its value before the stroke with coverage × opacity × selection. So a
  stroke crossing itself never exceeds Opacity, as in the reference app.
- Dab profile: hardness is the solid share of the radius; the rest fades with a smoothstep, with at least a
  one-pixel anti-aliased edge. (The reference app's exact soft-brush curve is not published.)
- Pen pressure scales size and/or opacity only when the options-bar toggles are on (off by default, as in the
  reference app's options bar).
- Number keys set the tool's opacity (Shift: flow) with the Brush/Eraser, and the selected layers' opacity
  (Shift: fill) with other tools; two digits within 0.4 s make one value.
- Undo/redo and Delete wait while a stroke or a polygonal lasso is in progress.
- `Workspace.whenIdle()` also waits for strokes being finished (used by tests).

## D-029 — 2026-10-07 — Edit > Fill

**Decision:**

- Fill blends a solid colour into the active layer through the selection, or over the whole canvas area when
  nothing is selected (also where a transparent layer has no pixels yet), with the compositing formula of
  FORMAT_NOTES §3.2 — the colour as a layer with the chosen mode and opacity over each pixel.
- Preserve Transparency keeps every pixel's alpha and moves only its colour; fully transparent pixels are left as they
  are. It is greyed out on the Background.
- 50 % Gray is 128/255 in each channel; Black and White are the extremes; colours convert to the document as in D-027.
- Delete/Backspace on the Background opens Fill with Background Color chosen (the reference app opens Fill there,
  defaulting to Content-Aware, which arrives later).
- Dialogs can stack (Fill opens the Color Picker); only the topmost reacts to Escape/Tab, and each dialog has its own
  title id (with a shared id, screen readers announced the picker as "Fill").

## D-030 — 2026-10-07 — Move tool

**Decision:**

- Moves are relative commands (translateLayers, moveSelectedPixels with dx, dy), so recorded Actions move whatever is
  selected on replay; drags show a live preview and record one "Move" step; arrow keys record "Nudge".
- Previews that arrive faster than they can run collapse to the latest one, so heavy previews (moving many pixels)
  never pile up.
- Dragging inside a selection moves the active layer's selected pixels (cut, or copied with Alt) and the selection
  outline with them; the vacated area becomes transparent, or the background colour where alpha cannot change.
  Pixels moved outside the canvas stay on layers with transparency; the Background keeps only what is on the canvas.
- Auto-Select (off by default) picks the topmost visible layer with a non-transparent pixel under the pointer (or its
  outermost group); Ctrl/Cmd-click inverts the option for one click. Refusals ("The Background layer cannot be moved")
  appear only when a drag actually starts.
- Arrow keys move the selection outline when a selection tool is active and there is a selection.
- Keyboard: app shortcuts pause while a modal dialog is open; navigation keys (arrows, Home/End, Page Up/Down, Enter,
  Space) stay with lists, sliders and menus. Delete and tool letters still work there.
- Duplicating a copy counts up ("Sky copy" → "Sky copy 2") instead of adding another "copy", as in the reference app.
- Fix: Fill with a selection now also fills where a layer has no pixels yet (a new layer).

## D-031 — 2026-10-07 — Crop, Canvas Size, Image Size, Image Rotation

**Decision:**

- All four are one command class: the document before and after are snapshots sharing unchanged tiles, the new
  layer pixels are made in the worker layer by layer (with progress; Esc cancels), and undo/redo swap snapshots.
  Each records one step ("Crop", "Canvas Size", "Image Size", "Rotate Canvas", "Flip Canvas Horizontal/Vertical")
  with replayable parameters; Image > Crop records no rectangle and crops to the selection on replay.
- Canvas Size and Crop move the selection with the image; rotation, flips and resampling deselect (Select > Reselect
  brings the old outline back, in its old place).
- Crop with Delete Cropped Pixels off turns the Background into "Layer 0" first, so the cropped pixels can be kept.
- The Crop tool works like the reference app's classic mode: dragging inside the box moves the box (not the image).
  Choosing another tool drops an unapplied box rather than asking whether to crop. Straightening, rotating the box,
  the other overlays, size/resolution presets and content-aware fill come with the full Crop tool (Part B).
- Image Size offers the six classic methods (FORMAT_NOTES §6). Preserve Details (enlargement), Preserve Details 2.0
  and the result preview are not in this item (Part B Image Size). Fit To lists our own common sizes; the image is
  fitted inside the box, turned to match the image's orientation.
- Canvas Size asks before cutting off part of the image. Its extension colour applies only with a Background
  (other layers get transparency), as in the reference app.
- After any change of canvas size the view shows the image centred at the same zoom.
- Number fields: Enter applies the value and, in a dialog, presses OK; leaving a field unchanged is not a change.
