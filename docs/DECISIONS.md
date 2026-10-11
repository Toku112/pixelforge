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

## D-032 — 2026-10-07 — Free Transform

**Decision:**

- The transform is a projective matrix in document coordinates, recorded as `freeTransform { matrix, interpolation }`
  (one step, "Free Transform"). Replayed Actions therefore transform at the same document position; transforms
  relative to the current layer come with the Actions work (Phase 11).
- Handles scale with proportions kept by default (corners and sides; the link button in the options bar), Shift
  frees them, Alt/Option scales about the reference point. Outside the box rotates (Shift: 15° steps); inside moves
  (Shift: one axis). Ctrl/Cmd + corner distorts, Ctrl/Cmd + side skews (with Alt, the opposite side moves the other
  way), Ctrl/Cmd+Alt+Shift + corner sets perspective. The reference point is hidden by default and can be shown and
  dragged, or placed with the 3 × 3 locator.
- Without a selection, every selected layer (and the layers in selected groups) is transformed; the Background is
  refused (as in the reference app), as are layers with locked position or pixels. With a selection, the selected
  pixels of the active layer move, and the selection with them; on the Background the old place gets the
  background colour.
- Live preview: whole layers are drawn on the GPU from a picture of each (8-bit sRGB, at most 4096 px a side,
  mipmapped) seen through the transform, with their blend mode and opacity, so dragging stays smooth on large
  documents; HDR values above 1 show clipped in the preview only. Transforming selected pixels previews through the
  command itself, computed only for the visible area at about one sample per screen pixel. Applying always
  resamples the full-resolution pixels in the worker.
- While the box is open, Undo/Redo and other edits are unavailable (the reference app lets Ctrl/Cmd+Z step back
  through the box's changes; not yet). Choosing another tool applies the transform (the reference app's default
  answer); switching documents applies it to the document it was started on.
- Not in this item (Part B Edit menu): Warp, Transform Again, the Edit > Transform submenu and the right-click menu,
  Edit > Transform's Rotate 90°/Flip, transforming several layers' selections at once.
- Fix: turning the Background into a normal layer (Layer from Background, duplicating it) carried the white past the
  canvas edge (inside its tiles) as visible pixels; that area is now transparent.

## D-033 — 2026-10-07 — Save As with formats; PSD via ag-psd

**Decision:**

- File > Save As asks for a name and a format (PSD, PNG, JPEG, WebP), then the browser's save dialog (or a download).
  Formats the image cannot be saved in are listed with the reason and cannot be chosen; a layered image saved in a
  flat format becomes a flattened copy (the dialog says so). The suggestion is the file's own format when it keeps
  everything, else PSD. Save (Ctrl/Cmd+S) writes in place when nothing would be lost (a PSD, or a flat image in its
  own format) and otherwise opens Save As. The format list says "PSD", never the vendor's product name.
- PSD reading and writing run in the codec worker through ag-psd, with plain pixel arrays (no canvas, which would
  premultiply alpha). The Background is recognised as described in FORMAT_NOTES §7.1. Features we cannot hold yet are
  simplified on opening and the user is told which ("Opened … with simplifications").
- Saving PSD is limited to 8-bit RGB documents until our own codec (Phase 7): ag-psd writes 8-bit RGB only.

## D-034 — 2026-10-07 — JPEG and WebP encoders (WebP lossy approach owner-approved)

**Context:** The Rust JPEG encoder crate carries the IJG licence (outside our allowlist, D-016) and there is no
pure-Rust lossy WebP encoder; building libjpeg-turbo/libwebp needs a C toolchain (D-002).
**Decision:**

- JPEG: our own encoder in the `codecs` crate, written from ITU-T T.81 (AAN floating-point DCT, standard tables,
  optimal Huffman tables, progressive by spectral selection). Options as in the reference app: quality 0–12 with
  presets, Baseline / Baseline Optimized / Progressive (3–5 scans), matte for transparency; settings remembered.
- WebP: lossless with image-webp (already a dependency). Lossy with the browser's built-in encoder (Chromium,
  Firefox); Safari offers lossless only. Approved by the owner on 2026-10-07 ("Use the browser's encoder"); a compiled
  libwebp can replace it when Phase 7 brings the C toolchain.
- Both option dialogs show the estimated file size, encoded in the worker a moment after each change.

## D-035 — 2026-10-08 — Pen input, brush tips and brush modes

**Decision:**

- Pointer input carries pressure, tilt, twist (barrel rotation), stylus wheel (tangential pressure, 0–1) and time
  into every stroke sample; strokes record them (`paintStroke` points with stride 8; the older x, y, pressure form
  still replays). Safari's altitude/azimuth are converted to tilt. Coalesced events are used for every position; when
  a browser gives none (synthetic events) the event itself counts. Predicted events move only the brush cursor ahead
  of the pointer: painting predicted dabs would need taking them back when the real positions arrive.
- Tips: the computed tip gains Angle, Roundness and Flip X/Y; sampled tips come from Edit > Define Brush Preset.
  The reference app's help does not say which layer it samples; we take the visible image (what you see), which also
  matches its "white and transparent paint nothing" rule. Tips larger than 2500 px on a side are refused; an empty
  selection says why. Tips live in a brush library kept in IndexedDB; strokes refer to them by id (a recorded stroke
  whose tip was deleted reports it instead of painting with another tip).
- The options bar follows the reference app: a brush preset picker (size, hardness, angle, roundness, flips, tips)
  replaces the separate Size and Hardness fields; the Brush has a Mode menu with Behind and Clear (greyed out where
  transparency cannot change). Alt+Shift+letter and Shift+Plus/Minus set the Brush's mode while it is active (Behind
  Alt+Shift+Q, Clear Alt+Shift+R); with the Eraser they do nothing.
- The brush cursor shows the tip's real outline (traced once per tip in the worker) at its angle and roundness.

## D-036 — 2026-10-08 — Brush dynamics and an early Brush Settings panel

**Decision:**

- Dynamics (Shape, Scattering, Transfer, Color Dynamics, Brush Pose) run after spacing, on the main thread while
  painting and again when a stroke replays; formulas in FORMAT_NOTES §8. Jitter uses a seeded generator; each stroke
  records its seed (and, with Color Dynamics, the foreground and background colours), so Actions and undo/redo replay
  the exact same dabs.
- Spacing follows the size a control sets (pressure, tilt, wheel, fade) but not random size jitter. The reference
  app's help does not state this; a pressure taper that breaks into dots at its thin end is not what painters expect,
  and spacing that jumps with every random size would make jittered strokes look uneven.
- Opacity Jitter varies each dab below the brush's Opacity (never above it), as the reference app describes Transfer.
- Color Dynamics are greyed out for the Eraser, which has no colour to vary.
- The Brush Settings panel (Window > Brush Settings, F5) is built now with the sections that exist so far, because
  dynamics need a place in the UI; Part E item 4 completes it. It opens as a floating window of its own size when the
  workspace does not include it (panels may now declare such a size), and its preview stroke is painted by the same
  engine in the worker.
- Small fixes found on the way: the app never grows wider than the window (a full options bar runs off the right edge
  instead of pushing the panels away), and the page cannot be scrolled sideways by focusing a control.

## D-037 — 2026-10-08 — Texture, Dual Brush, Noise, Wet Edges, Build-up

**Decision:**

- The reference app does not publish the arithmetic of its texture and dual-brush modes. We wrote our own (FORMAT_NOTES
  §8) from what each mode is described to do: depth 0 leaves the paint alone and 100 % leaves the pattern's darkest
  parts bare; Height and Linear Height treat the pattern as a relief that more paint reaches deeper into, and grow
  more opaque with depth (users report that above about 20 % depth those modes paint solid, so we match that). These
  formulas are the first thing to check against real output when the owner can provide some; the golden tests will
  then take that output as the expected images.
- Patterns: a built-in set drawn by our own code (Paper, Rough Paper, Canvas, Grain, Hatching, Dots), seeded and
  tileable, kept in core so recorded strokes find them anywhere. The pattern library gains user patterns with Edit >
  Define Pattern (Part E item 12).
- The Dual Brush's size is kept as a share of the brush size, shown in pixels, so it scales when the brush does (as
  in the reference app). Its dabs use their own random stream, so changing the dual settings never moves the main
  dabs.
- Wet Edges uses a second, shrunken coverage to find the stroke's rim, so hard tips get a visible rim (a tenth of the
  diameter) instead of a one-pixel line.
- Build-up adds 30 dabs a second where the pointer rests; the repeated samples are recorded with their times, so a
  held press replays the same.
- Protect Texture keeps one texture across brush presets, so it comes with presets (Part E item 7) instead of now,
  when there are no presets to switch between.

## D-038 — 2026-10-08 — Brush options bar, brush HUD, painting cursors and Preferences

**Decision:**

- Edit > Preferences (Ctrl/Cmd+K) is a dialog with a page list; it starts with the pages that have settings so far
  (Tools: Overscroll and the HUD's vertical axis; Cursors: painting cursors and the HUD preview colour). Values live in
  IndexedDB (database `pixelforge-settings`, apart from the brush library so neither needs a version upgrade for the
  other), apply as soon as OK is pressed, and fall back to the defaults where storage is blocked or values are damaged.
- Painting cursors as in the reference app: Normal Brush Tip (the default) hides the system pointer and outlines
  where the tip paints at least half — for a round tip the middle of its soft rim, for a sampled tip the traced 50 %
  contour; Full Size outlines all of it; Precise is the crosshair; Standard is the tool's own icon (our drawing). Tiny
  outlines show a crosshair instead. Caps Lock swaps any of them for the crosshair (and the crosshair for the
  outline).
- The brush HUD: Alt+right-drag on Windows/Linux, Ctrl+Option-drag on macOS. Horizontally the outline's edge follows
  the pointer (diameter ± 2 × the distance in image pixels); vertically 1 % per screen pixel, up softer and down
  harder — or the opacity for sampled tips or with the preference off. The preview is the tip filled in the preview
  colour at half opacity, soft where the tip is soft, with a readout beside it. The canvas has no browser context
  menu (the right button belongs to the app).
- The options bar follows the reference app: a Brush Settings toggle beside the preset picker, an airbrush toggle
  after Flow (the Build-up setting), and a brush angle field (its icon is the drag handle). Spacing moved to the
  Brush Settings panel, which also gains the angle/roundness dial, the Spacing checkbox (off: one dab per pointer
  sample, so speed sets the spacing), Use Sample Size for sampled tips, and Clear Brush Controls in its menu.

## D-039 — 2026-10-08 — Stroke smoothing

**Decision:**

- Smoothing is our own model of the behaviour described for the reference app: the paint hangs on a string from the
  pointer. The string's length is Smoothing × 60 CSS pixels on screen (Adjust for Zoom on) or × 60 image pixels (off);
  once the pointer is farther away the string pulls the paint after it. Except in Pulled String Mode, the paint also
  drifts towards the pointer with a time constant of Smoothing × 150 ms — during pointer moves, and with Stroke
  Catch-up also while the pointer rests (a timer); so small moves within reach still paint, lazily. Catch-up on
  Stroke End paints the last stretch to where the pointer was released. Defaults as in the reference app: 10 %, Stroke
  Catch-up and Adjust for Zoom on, the others off.
- The brush's Smoothing setting (Brush Settings, on by default) is curve smoothing: a Catmull-Rom curve through the
  points, drawn one point behind (imperceptible at pointer rates), every sample still on the path.
- Smoothing happens before recording: a stroke records the path the paint took, so a replayed stroke needs no
  smoothing settings and paints exactly the same; smoothing settings belong to the tool, not to the brush settings
  a stroke records.
- While painting with smoothing, the string is drawn from the pointer to the paint (with its reach as a circle in
  Pulled String Mode).

## D-040 — 2026-10-08 — Paint symmetry

**Decision:**

- A symmetry is part of the document (not of a tool): a type, centre, angle, size and segment count, set by the
  `setSymmetry` command, so choosing a type ("New Symmetry"), placing it ("Transform Symmetry") and turning it off
  are History steps. Hide Symmetry only hides the guide on screen.
- The reference app keeps symmetry as a special path; we have no paths yet (Phase 5), so the guide is placed by
  moving, turning and sizing it, and is not yet written to PSD files. Paths will bring both: editing the guide's
  points, and storing it in the file.
- Copies are made from the dabs (after spacing, dynamics and the dual brush): every copy is an exact mirror or turn of
  the original stroke, jitter included, and all of them are one stroke for Opacity. The Wavy, Circle and Spiral
  mirrors are our own geometry from the descriptions of those types (FORMAT_NOTES §8).
- Radial and Mandala ask for 2–12 segments (5 the first time, then the last count). A new symmetry is centred on the
  canvas, then placed at once (Enter applies, Escape keeps it where it was created).

## D-041 — 2026-10-08 — Brush presets, brush files and tool presets

**Decision:**

- A brush preset is a name, a group and full brush settings (tip, size, every Brush Settings section); it may include
  the tool settings (opacity, flow, mode, smoothing). The library (presets, groups, recent brushes, user tips,
  imported patterns, tool presets) lives in IndexedDB (database `pixelforge-library`, now version 2; the brush tips
  saved before are kept).
- Our default library is our own: 19 presets in four groups, with seven sampled tips drawn by code (charcoal, chalk,
  bristles, spatter, star, leaf, grass) and our built-in patterns. The defaults are copied into the library the first
  time, so they can be renamed, moved or deleted; Restore Default Brushes brings them back (same ids, replacing
  changed copies). Built-in tips and patterns are never stored: every copy of the app has them, and strokes and
  presets name them by id.
- Edit > Define Brush Preset now also makes a preset with the new tip (and chooses it), as the reference app adds the
  new brush to the Brushes panel.
- Brush files: ABR versions 6–10 are read with ag-psd's reader (already a dependency; MIT) in the codec worker and
  mapped onto our settings; tips and patterns get ids prefixed per import so they never clash. What we cannot paint
  yet is approximated and listed after the import (bristle and erodible tips become round tips; wetness and mix wait
  for the Mixer Brush). Textures whose pattern the file does not carry use our Paper pattern. ABR versions 1–2
  (before 2003) are refused with a clear message for now. Our own file (.pfbrush) is JSON with the presets and the
  pixels of the user tips and patterns they use (FORMAT_NOTES §9); Export Brushes asks which groups.
- Tool presets save the active tool with its settings (the brush tools with their smoothing and Protect Texture);
  choosing one switches to its tool. Tools without settings (Hand, Zoom's view actions) have none. The options bar's
  tool icon opens the active tool's presets, as in the reference app.
- Deleting a preset keeps its tip in the library: recorded strokes (Actions) may still need it.

## D-042 — 2026-10-08 — Dab rendering in WebAssembly

**Decision:**

- The pixel-ops crate gains `BrushStroke`: a stroke's tiles before the stroke and its coverage live in WebAssembly
  memory for the whole stroke; each batch of dabs is painted there and only the changed tiles are copied into the
  layer's arrays (one copy, from a view of the module's memory). With the threaded build the tiles a dab touches are
  painted in parallel on the rayon pool.
- It follows the TypeScript renderer step by step (f64 arithmetic, coverage stored as f32, rounding as JavaScript's
  `Math.round`, i.e. `floor(v + 0.5)` — also a single WebAssembly instruction where Rust's `round` is a library call),
  so both paint identical pixels; a unit test compares them across bit depths, modes, layouts, selections, offsets and
  sampled tips, and fails on any difference. Live strokes, recorded strokes (Actions) and replays use the same path.
- It covers the plain stroke (Normal, Behind, Clear and erasing; round and sampled tips; Opacity, Flow, selection,
  locked transparency) — the big soft brush the target names. Strokes with blend modes, texture, dual brush, wet
  edges, noise or colours/opacities that vary per dab keep the TypeScript renderer for now; moving those later only
  needs the same equivalence test.
- Measured: a 500 px soft 16-bit dab went from ~16 ms (TypeScript) to ~2.5 ms single-threaded; in the app (threaded)
  a dense stroke on a 6000 × 4000 16-bit document keeps 60 fps and finishes 13 ms after the pointer is released.

## D-043 — 2026-10-08 — Eyedropper, Color and Swatches panels

**Decision:**

- Sampling composites exactly what is sampled (all layers; the current layer; the current layer and everything below
  it, into the group that holds it) for the sample square in the pixel worker, then averages the colours weighted by
  their alpha. Where nothing is painted the colour stays as it was (the reference app leaves it alone there too). The
  result becomes sRGB 0–1 (gray as equal channels; 32-bit from linear light).
- While the pointer is down the colour updates as it moves, one sample at a time (the newest position waits for the
  previous sample), and the ring shows the new colour over the one it replaces. Escape restores it. With the Brush,
  Alt/Option-click samples with the Eyedropper's options and paints nothing (the Eraser keeps Alt for later).
- The Color panel edits the foreground or the background (radio squares), with RGB, HSB, Grayscale or Lab sliders whose
  tracks show the colours they lead to, a hex field and a ramp (spectrum, grayscale, current colours). HSB keeps the
  hue the user set while a colour is gray or black, so the sliders do not jump.
- Swatches are kept in IndexedDB (library value `swatches`); our default groups are ours. .ase and .aco files import
  as groups; CMYK swatches become sRGB by the simple uncalibrated formula and Lab ones through D65 sRGB until colour
  management (Phase 7) converts them properly. Click sets the foreground, Ctrl/Cmd-click the background, as in the
  reference app.
- Panels opening as floating windows cascade (each a little lower and further left) instead of covering each other.

## D-044 — 2026-10-08 — Pencil and Eraser modes

**Decision:**

- Hard pixels (`aliased` brushes): a round tip paints a pixel fully when the pixel's centre is within the tip's radius
  (so a 1 px pencil paints exactly one pixel), a sampled tip where it covers at least half the pixel; nothing else is
  painted. The Pencil is aliased, sized 1 px by default, has no Flow or airbrush, and starts with Smoothing at 0 % so
  pixel work goes exactly where the pointer goes. The Eraser's Pencil mode is its brush, aliased.
- Auto Erase compares the pixel under the start of the stroke with the foreground colour exactly (as samples of the
  document; transparent pixels never match) and, when they match, paints the background colour for the whole stroke.
- The Eraser's Block mode erases a full-strength square 16 screen pixels wide (our square built-in tip, aliased) at the
  current zoom; the stroke records it in image pixels, so a replay erases the same square at any zoom. Block has no
  other options, as in the reference app.
- The Brush and Pencil share B (Shift+B switches), as in the reference app's toolbar group.

## D-045 — 2026-10-08 — Gradient tool, Gradient Editor and gradient files

**Decision:**

- The Gradient tool is the classic mode: a drag paints the gradient into the active pixel layer (through the
  selection), one History step "Gradient". The live gradient that makes a gradient fill layer comes with fill layers
  (Phase 3, PLAN Part B), which it needs.
- How colours mix is our own approximation of the reference app's methods (the exact curves are not published):
  Perceptual mixes in Oklab, Linear in linear light, Classic the stored sRGB values; Smooth eases in and out of every
  stop; Stripes makes a hard step at each midpoint. Smoothness blends straight lines with a Catmull-Rom spline through
  the stops (the ends counting as repeated), kept from overshooting past the two stops it joins; at 100 % a two-stop
  gradient follows 0.5u + 1.5u² − u³. Midpoints bend the position between two stops by a power curve that passes half
  way at the midpoint. Opacity stops mix as plain numbers with the same curve. Real reference output, once the owner
  provides it, will tell how close this is; FORMAT_NOTES §11 has the formulas.
- Noise gradients keep the reference app's settings (roughness, colour model with per-channel ranges, Restrict
  Colors, Add Transparency, a seed) but their random colours are ours: 2–64 random points per channel, joined straight
  (rough) or eased (smooth). Restrict Colors caps saturation at 80 %.
- The angle gradient sweeps counter-clockwise on screen from the drag direction; the diamond's corner is the end point.
- The method is an option of the tool (as in the reference app's options bar), not part of the gradient; the
  foreground and background stops are given their colours when the drag ends, and the command records the gradient
  with those colours, so a replay paints the same.
- Dither adds per-pixel noise of ±½ level (8- and 16-bit; none in 32-bit) from a hash of the pixel position, so
  replays are identical.
- The fill blends with Edit > Fill's formulas (now shared, `blendSourceTiles`), plus Behind and Clear; it runs in the
  pixel worker in chunks of 32 tiles, reporting progress and stopping on Esc. A 6000 × 4000 16-bit linear gradient
  takes about 0.7 s in TypeScript; moving it to WebAssembly is possible later if needed.
- Gradient presets live in IndexedDB (library value `gradients`) in groups; our default gradients are ours. The Gradient
  Editor works on a copy: OK makes it the tool's gradient (no longer marked as a preset when changed), New adds it to
  the presets. Stops: click beside the bar to add (with the gradient's colour/opacity there), drag to move, Alt-drag to
  copy, drag away to remove (two always stay), double-click or Enter to pick a colour, arrows to nudge.
- .grd files (version 5) are read and written by our own action-descriptor reader/writer (`src/io/descriptor.ts`),
  which later features (styles, actions, tool presets, PSD descriptors) will reuse. Version 3 files (before 2000) are
  refused with a clear message. Colours other than RGB become sRGB as with swatch files; colour-book colours, whose
  values the file does not hold, become gray with a note.

## D-046 — 2026-10-08 — Patterns: Define Pattern, Patterns panel, .pat files, pattern fill, Pattern Stamp

**Decision:**

- Patterns are kept as 8-bit RGBA sRGB images (the format the brush Texture already used). Define Pattern in a 16- or
  32-bit document therefore stores 8 bits per channel (32-bit converted from linear light); a pattern is turned into
  the document's values when it is used (Grayscale: luma; 32-bit: linear). Storing higher-depth patterns can come with
  pattern fill layers if needed.
- Edit > Define Pattern takes the visible image (all visible layers) in the selection's rectangle, or the whole canvas
  without a selection, up to 4000 × 4000 pixels. As in the reference app it needs a rectangular selection without
  feathering: the pixel worker checks that every pixel of the rectangle is fully selected and the user is told
  otherwise (the menu item stays enabled, since checking the mask on every menu redraw would be costly).
- The Patterns panel shows groups; our built-in patterns form "Textures". Deleting one of ours only hides it (brushes
  and recordings may use it by id); Restore Default Patterns shows them again. The user's patterns live in IndexedDB;
  the groups in the library value `patternGroups`. Patterns that belong to no group (from brush files made before
  groups) appear under "Other Patterns". Restoring defaults (patterns, gradients, swatches) now keeps the user's own
  items that were in a default group — before, swatches and gradients added to a default group were dropped.
- Edit > Fill's Pattern contents repeat the pattern from the document's top left corner and honour its transparency;
  the descriptor records the pattern's id. (Scripted patterns are not part of this item.)
- The Pattern Stamp (S; the Clone Stamp will join it) paints through the brush engine with the pattern's colour at
  each pixel, its transparency lowering the paint. Aligned fixes the pattern to the document's top left; otherwise it
  starts where each stroke starts (the whole pixel under the press). Impressionist paints each dab in one colour: the
  pattern's at the dab's centre. Strokes record the pattern id, origin and Impressionist, so they replay. These
  strokes are painted by the TypeScript renderer (the WebAssembly painter handles plain colours only).
- .pat files are read and written by our own code (`src/io/pat.ts`, FORMAT_NOTES §12) in the codec worker. Colour
  channels are the first written arrays of the pattern's image; the next written one is its transparency. CMYK is
  converted with the simple uncalibrated formula and Lab through D65 sRGB, as for swatches. We write RGB(A),
  uncompressed.

## D-047 — 2026-10-09 — Paint Bucket

**Decision:**

- The area is found in the pixel worker (`src/core/selection/bucket.ts`, FORMAT_NOTES §13): a pixel belongs when its
  colour is within Tolerance of the clicked pixel's, comparing premultiplied values as the largest difference of any
  channel or the alpha on a 0–255 scale. Premultiplying makes every fully transparent pixel the same colour, so a
  click in an empty part of a layer fills all the empty space it joins, whatever colour the hidden pixels hold.
  Contiguous joins pixels through their four neighbours (not diagonals), so a one-pixel diagonal line holds a fill.
- Anti-alias gives each pixel just outside the area partial coverage — full minus how far beyond Tolerance its colour
  is — so a fill meets anti-aliased line art without a light gap or a hard step. The reference app's exact edge
  softening is not documented; this is our own rule, to be compared with real output.
- Without All Layers the colours compared are the active layer's own pixels as if it were visible, opaque and in
  Normal mode (its opacity, blend mode and visibility do not matter); with All Layers, what all visible layers show.
  Only the active layer changes either way.
- The fill reuses Edit > Fill's blending (`fillTiles`, now also taking Behind and Clear) with the area as its mask;
  the selection limits the area and its soft values carry over. Locked transparency (and the Background) keep alpha,
  as with the Gradient tool. Patterns repeat from the document's top left corner, as in Edit > Fill. A click outside
  the canvas or the selection does nothing (no History step).
- The descriptor records the click pixel, the options and the colour as document values (or the pattern's id), so an
  Action replays the same fill.
- The image is composited in 256-pixel blocks only as the fill reaches them: a small fill in a 6000 × 4000 image takes
  about 5 ms; filling half of it about 0.6 s and every pixel (not Contiguous) about 1 s in the worker, most of it in
  the TypeScript compositor (`flatten`), which a faster compositor would speed up for every feature using it.
- The blend-mode shortcuts (Alt+Shift+letter, Shift+Plus/Minus) and the number keys now set the Mode and Opacity of
  the Gradient tool and the Paint Bucket while they are active, as they do for the Brush, rather than the layer's.
- The Paint Bucket's pattern follows the pattern last chosen (Patterns panel, Edit > Fill, either tool's picker), as
  the Pattern Stamp's does.

## D-048 — 2026-10-09 — History Brush, Art History Brush, Erase to History, Fill > History

**Decision:**

- The History Brush source is one History entry (the opening state until the user clicks another row's left column in
  the History panel). Its state is captured the moment it is chosen — for a state other than the current one by
  stepping the history there and back, with every tile both trips need loaded first — as the same cheap snapshot the
  opening state uses (tiles are shared, not copied). Painting never steps through the history, and the captured state
  stays valid while the History changes. When the source entry disappears (undone states discarded by a new step, or
  the oldest states dropped past the limit), the opening state becomes the source again, as the source row is gone.
- Painting from the source uses the source state's version of the layer being painted — the layer with the same id —
  read at the same document position (so a layer moved since is painted back where it was). The state must have that
  layer and the same canvas size, colour mode and bit depth; otherwise the History Brush, Art History Brush, Erase to
  History and Fill > History refuse with our own explanation, as the reference app does.
- In Normal mode (and Dissolve, and Erase to History) the History Brush moves each pixel towards the source pixel,
  transparency included: a layer that was empty becomes empty again where painted, rather than the source being
  painted over it. Other modes blend the source's colours like paint, its transparency lowering the paint. Locked
  transparency and the Background keep alpha; only colours move. Fill > History uses the same rule over the
  selection (or canvas). The exact compositing of the reference app is not documented; this is the expected result of
  "painting a copy of the state back", to be compared with real output.
- History Brush and Erase to History strokes are painted by the TypeScript renderer, which receives the source tiles
  each batch of dabs needs (the WebAssembly painter handles plain colours only, as with the Pattern Stamp). Measured
  in Node: about 15 ms per 500 px soft dab on a 16-bit layer (a plain-colour dab in TypeScript: about 9 ms). Painting
  stays off the main thread and never falls behind (dabs queue), but very large history brushes trail the pointer;
  moving these strokes to the WebAssembly painter is a later performance task.
- The Art History Brush's strokes are our own design (FORMAT_NOTES §14): bursts of short strokes start at random
  points within Area around the pointer, each in the source's colour at its start, running along the source's edges
  (Tight), wandering (Loose), turning (Curl) or as single dabs (Dab); bursts follow the pointer and continue while it
  rests. Tolerance compares the source with the layer as it was when the stroke began, so a stroke replays the same.
  The strokes are placed on the main thread from point reads of the source (a few thousand per burst, well under a
  millisecond); its mode menu is Normal, Darken, Lighten, Hue, Saturation, Color and Luminosity.
- Neither history brush paints with paint symmetry (the reference app offers symmetry for the Brush, Pencil and
  Eraser). Alt/Option held when an Eraser stroke starts switches Erase to History for that stroke.
- Ctrl/Cmd+Alt/Option+Backspace (and Delete) fills from history, Normal at 100 %, like the reference app's shortcut.
- Strokes record the tool (`history-brush`, `art-history-brush`, or the Eraser with `toHistory`) and the Art History
  options; Fill records `history: true`. Replayed in an Action, they paint from the History Brush source of the
  document they are replayed on.
- History snapshots (New Snapshot) and non-linear history are left for the History panel item (PLAN B16).

## D-049 — 2026-10-10 — Mixer Brush

**Decision:**

- The Mixer Brush (B, after the Pencil in the Brush group; Shift+B cycles Brush → Pencil → Mixer Brush) is a painting
  tool of its own kind: a brush that holds paint. Its reservoir is filled with the foreground colour (choosing a
  foreground colour anywhere, or Load Brush, loads it), or with Alt/Option-click with the image under the tip — the
  active layer's own pixels, or what all visible layers show with Sample All Layers — averaged down to at most
  256 × 256, or only its average colour with Load Solid Colors Only. Clean Brush empties the brush. Loading after each
  stroke refills the reservoir with what it was last loaded with; cleaning after each stroke empties the reservoir and
  what the brush took up. Both are on at first. A brush neither cleaned nor loaded carries its paint, colours taken
  up from the canvas included, into the next stroke.
- How wet paint mixes is our own model (FORMAT_NOTES §15), built to the reference app's description of the controls:
  Wet = how much canvas paint the brush takes up and drags (0 %: it paints its reservoir like the Brush); Load = how
  long the reservoir lasts (100 %: it never runs dry, so Dry at 100 % paints like the Brush); Mix = the share of
  canvas paint in what is laid down (disabled at Wet 0 %, as in the reference app). What one dab adds is its share of
  one pass of the whole tip over a pixel (by the distance it moved), so results hardly depend on the brush spacing;
  the first dab counts as half a pass, so a click leaves a visible dab. Checked visually on colour stripes at 10 % and
  25 % spacing; to be compared with real output.
- The useful combinations are our own values in the reference app's arrangement: Dry, Moist, Wet and Very Wet (Wet 0,
  10, 50 and 100 %), each plain (Load 50 %, Mix 50 %) and with a Light (5 %) or Heavy (100 %) Load, and the wet ones
  with a Light (20 %) or Heavy (100 %) Mix. Our defaults (Wet 100 %, Load 50 %, Mix 50 %) match Very Wet; the menu shows
  Custom for other values.
- No blend mode and no opacity (the reference app has neither for this tool). Number keys set Wet, Shift+number Flow
  and Alt/Option+Shift+number Mix, as the reference app's default shortcuts do; the blend-mode shortcuts do nothing.
- The Mixer Brush starts with 5 % spacing: with wet paint each dab of a 25 % spaced round tip shows as a bead.
- Brush Settings: Transfer gains Wetness Jitter and Mix Jitter (Mixer Brush only; Opacity Jitter is greyed for it);
  .abr brushes keep theirs. Texture, Dual Brush, Color Dynamics and Wet Edges are greyed for the Mixer Brush: its paint
  comes from the reservoir and the canvas, and these shape a whole stroke's coverage, which a brush that changes the
  canvas dab by dab does not have. Noise applies.
- Sample All Layers reads the visible layers under the active layer as they were when the stroke began, with the
  active layer over them as it is being painted (Normal, at its opacity × fill). Layers above the active layer are
  left out: they would hide the paint the brush takes up from the layer being painted.
- With paint symmetry each mirror image has a brush of its own (a mirror image never drags the original's paint);
  the stroke's own brush is the one carried into the next stroke.
- A stroke records what the brush held as it began — reservoir paint, its level and the paint taken up earlier — as
  16-bit samples (32-bit floats in 32-bit documents) in base64, so Actions replay it exactly; the live stroke starts
  from the same decoded values. Paint taken up is kept as a square the size of the brush's largest dab; its bytes
  count towards the History's memory. Paint from an image of another colour mode gives way to the foreground colour.
- Mixer strokes are painted by the TypeScript renderer in the pixel worker (each dab changes what the next one takes
  up, which the coverage-based WebAssembly painter does not do). Measured in Node: about 0.9 ms per 100 px dab and 19 ms
  per 500 px soft dab at 5 % spacing, i.e. the brush keeps up with about 1,300 px of travel per second at 500 px;
  moving it to WebAssembly is a later performance task.
- Found while testing: a stroke begun while the stroke before it was still being finished could copy a tile the earlier
  stroke was still painting, losing the end of that stroke. Every stroke on a document now waits for the one before
  it to be recorded before touching tiles (all painting tools).

## D-050 — 2026-10-11 — Dodge, Burn and Sponge

**Decision:**

- Dodge, Burn and Sponge (O; Shift+O cycles) are painting tools whose strokes change the tones of the pixels instead
  of painting a colour. They use the brush engine's coverage model: a stroke's amount at a pixel is Exposure (Dodge,
  Burn) or 100 % (Sponge) times the stroke's coverage there, built up dab by dab with Flow, and the pixel is recomputed
  from its value before the stroke. So one stroke never goes past its Exposure however often it crosses itself, and a
  new stroke builds on the last — as a brush's Opacity behaves. Texture, Dual Brush, Wet Edges, Noise, Transfer,
  build-up and smoothing all apply; Color Dynamics is greyed. No paint symmetry (the reference app offers it for the
  painting brushes only).
- The tone curves are our own (FORMAT_NOTES §16): each range weights tones (shadows (1 − v)², midtones 4v(1 − v),
  highlights v²) and Dodge moves a tone towards white, Burn towards black, by half that weight at full amount.
  Protect Tones changes the luminance only and keeps the colour's hue without clipping (Dodge scales the distance to
  white, Burn the distance to black, of every channel alike); without it each channel is changed by its own tone, so
  hues shift. Sponge moves colours away from (Saturate) or towards (Desaturate) their gray, by up to 75 % at full
  amount; Vibrance gives saturated colours less saturation and nearly gray ones less desaturation, and keeps
  saturating colours from clipping. In Grayscale the Sponge raises or lowers contrast around middle gray. To be compared
  with real output.
- Alt/Option held when a stroke starts paints that stroke as the other of Dodge and Burn, with the tool's own Range
  and Exposure; it is recorded as that tool ("Burn Tool"). Number keys set Exposure (Dodge, Burn) or Flow (Sponge).
- Defaults: Midtones, Exposure 50 %, Protect Tones on; Sponge Desaturate, Flow 50 %, Vibrance on.
- They do not work on 32-bit images (as in the reference app): the tool explains this instead of painting, and a
  recorded stroke replayed on a 32-bit document is refused.
- The strokes are painted by the TypeScript renderer in the pixel worker (the WebAssembly painter covers plain colours
  only).
