# CLAUDE.md — How to work on this project

> Read this file completely at the start of every session. Then read `PLAN.md`.
> `PLAN.md` is the source of truth for *what* to build. This file is the source of truth for *how* to build it.

---

## 1. Mission

Build **PixelForge** (working title — the owner may rename it; keep the name in one constant, `APP_NAME` in `src/app/brand.ts`) — a browser-based, professional raster image editor that is **feature-equivalent and workflow-compatible with Adobe Photoshop (2026 / v27.x)**.

"Feature-equivalent" means:

- Every tool, menu command, panel, adjustment, filter, blend mode and layer style listed in `PLAN.md` exists and **produces visually equivalent results** to Photoshop.
- A Photoshop user can sit down and work without relearning: same menu structure, same tool groupings, same **default keyboard shortcuts**, same panel names, same modifier-key behaviours (Shift = constrain/add, Alt/Option = subtract/from-center/sample, Ctrl/Cmd = temporary Move, etc.).
- It opens and saves **PSD/PSB** files with layers, groups, masks, adjustment layers, smart objects, text and layer styles preserved, so files round-trip with real Photoshop.
- It is usable professionally: large documents, 8/16/32-bit, colour management (ICC), CMYK/Lab, print output, fast and stable.

### 1.1 Legal and brand rules (non-negotiable)

Functional compatibility is the goal. Copying Adobe's protected expression is not. Therefore:

- **Never** use the names "Adobe", "Photoshop", "Firefly", "Creative Cloud" or Adobe logos anywhere in the product UI, app name, icons, splash screens, file names, package names or marketing copy. Referring to "PSD file format" and "Photoshop-compatible shortcuts" in docs/settings is fine (that's descriptive).
- **Draw all icons ourselves** (or use a permissively licensed icon set such as Lucide/Tabler as a base and customise). Never extract, trace, or screenshot Adobe icons, cursors, splash art, sample images or brush thumbnails.
- **Do not copy text** from Adobe's help pages into the code or UI (tooltips, dialog help text). Write our own wording. Use Adobe's documentation only as a *behavioural reference* (what does this control do, what's the range, what's the default).
- Do not bundle Adobe presets, ABR brushes, patterns, gradients, LUTs, Camera Raw profiles or fonts. Create our own defaults. Users may **import** their own files (ABR, PAT, GRD, ASL, ASE, CUBE, ATN) — implementing importers for these formats is fine.
- Do not include Pantone or other licensed colour libraries. Support importing ASE/ACO swatch files instead.
- Check the licence of every dependency and every ML model before adding it. Allowed by default: MIT, BSD, Apache-2.0, ISC, Zlib, MPL-2.0 (as a separate module). Ask the owner before adding anything GPL/AGPL/non-commercial. Record every dependency in `docs/THIRD_PARTY.md`.

---

## 2. Tech stack (decided — don't change without asking)

| Concern | Choice | Notes |
|---|---|---|
| Language | **TypeScript** (strict) | `strict: true`, `noUncheckedIndexedAccess: true` |
| Build | **Vite** | |
| UI shell | **React 18+** with **Zustand** for UI state | React renders panels/menus/dialogs only. **Never** render the canvas through React. |
| Rendering / compositing | **WebGL2** engine (own code), WebGPU backend later behind same interface | Tiled, float16/float32 textures for 16/32-bit |
| Heavy pixel ops | **Rust → WebAssembly** (`wasm-pack`), SIMD enabled, run in **Web Workers** | Filters, resampling, healing, file codecs, colour conversion |
| Colour management | **Little CMS 2 (lcms2) compiled to WASM** | ICC v2/v4, all rendering intents, black point compensation |
| File: PSD/PSB | Start with **ag-psd** for reading/writing; replace with our own Rust codec by Phase 7 | ag-psd only writes 8-bit RGB 3-channel, no ZIP compression, incomplete text — we need CMYK, 16/32-bit, ZIP, full text engine data |
| Other codecs | libjpeg-turbo, libpng/zlib-ng, libwebp, libavif, libjxl, libtiff, OpenEXR, LibRaw — all compiled to WASM | |
| Text shaping | **HarfBuzz (harfbuzzjs)** + **opentype.js / fontkit** for font parsing | Plus Local Font Access API for system fonts |
| ML inference | **ONNX Runtime Web** (WebGPU EP, WASM fallback) | All AI features go through `AIProvider` interface (see §6) |
| Storage | **OPFS** (Origin Private File System) for tile swap/"scratch disk" and autosave; **IndexedDB** for presets/settings; **File System Access API** for open/save in place | |
| Video | **WebCodecs** + mp4-muxer / webm-muxer | |
| Testing | **Vitest** (unit), **Playwright** (E2E + visual regression), golden-image pixel tests | |
| Lint/format | ESLint + Prettier, `cargo clippy` + `rustfmt` | |

Target browsers: latest Chrome/Edge (primary), Firefox, Safari (best effort; feature-detect WebGPU, OPFS, File System Access, Local Font Access and degrade gracefully).

---

## 3. Architecture rules

These rules exist because a Photoshop-class app collapses under its own weight if they are broken. Follow them strictly.

### 3.1 Layered architecture

```
src/
  app/            # bootstrapping, brand constants, routing, service wiring
  core/           # PURE document model. No DOM, no React, no WebGL. Runs in Node for tests.
    document/     # Document, Layer tree, Channels, Paths, Guides, Slices, Metadata
    commands/     # Every mutation is a Command (see 3.2)
    history/      # Undo/redo, snapshots, History panel model
    selection/    # Selection as 8-bit (or float) mask + vector outline cache
    color/        # Colour models, conversions (calls color WASM), ICC handling
    actions/      # Action recording/playback, descriptor format
    scripting/    # Public scripting API surface
  engine/         # Rendering: tile manager, compositor, blend modes (GLSL), layer-style renderer
    gl/           # WebGL2 backend
    gpu/          # WebGPU backend (later)
    tiles/        # Tile storage, mipmaps, OPFS swap, memory budget
  wasm/           # Rust crates: filters, resample, heal, codecs, colour, raw
  tools/          # One folder per tool: tool logic + options model (UI-agnostic)
  ui/             # React: menus, panels, dialogs, options bar, toolbar, workspaces
  io/             # File import/export, format registry
  ai/             # AIProvider interface + local ONNX implementations + optional remote provider
  plugins/        # Plugin host (sandboxed)
  workers/        # Worker entry points
tests/
  unit/  e2e/  golden/  fixtures/   # fixtures: PSDs and images with known expected output
docs/
  THIRD_PARTY.md  DECISIONS.md  FORMAT_NOTES.md  KNOWN_GAPS.md
```

`core/` must never import from `ui/`, `engine/` or browser APIs. `ui/` talks to `core/` only through commands and read-only selectors.

### 3.2 Everything is a Command

- Every change to a document (paint stroke, move, adjust, rename layer, change blend mode…) is a `Command` with `do()`, `undo()`, a serialisable **descriptor** (name + parameters as JSON), and a human-readable history label ("Brush Tool", "Levels", "Free Transform").
- This one rule gives us: undo/redo, the History panel, **Actions recording** (record descriptors, replay them), scripting, batch processing and crash-recovery journaling. Do not bypass it "just this once".
- Pixel commands store undo data as **tile diffs** (only tiles that changed), never whole-layer copies.

### 3.3 Pixel data

- Documents are **tiled** (256×256 tiles). Tiles are lazily allocated, copy-on-write, and can be evicted to OPFS when over the memory budget (user-configurable in Preferences > Performance, default 60% of `navigator.deviceMemory` estimate).
- Internal storage per bit depth: 8-bit = Uint8, 16-bit = Uint16 (Photoshop's 16-bit is 0–32768; store full 0–65535 internally, convert on PSD I/O), 32-bit = Float32 (linear, HDR, values >1 allowed).
- Colour modes are first-class: RGB, CMYK, Lab, Grayscale, Duotone, Indexed, Bitmap, Multichannel. Do **not** fake CMYK by storing RGB.
- Blend modes and adjustments must be implemented **in the document's colour space**, matching Photoshop's math (e.g. CMYK blending behaves inverted; Lab has its own rules). Document every formula in `docs/FORMAT_NOTES.md`.

### 3.4 Rendering

- Composite on the GPU, tile by tile, only for dirty regions, with a mip pyramid for zoomed-out views.
- Never block the main thread for >50 ms. Long operations run in workers, show a progress bar, and are cancellable with Esc.
- The canvas must keep painting at ≥60 fps while panning/zooming a 50-layer 8000×6000 document on a mid-range laptop.

### 3.5 Non-destructive first

Adjustment layers, smart objects, smart filters, layer styles, masks and live shapes must remain editable after save/reopen. If an operation would destroy editability (rasterize, merge), it must be explicit and undoable, exactly like Photoshop.

---

## 4. How to work (your loop)

Repeat this loop for every task:

1. **Pick the next task.** Open `PLAN.md`, go to the current phase, take the first unchecked `[ ]` item (or the item the owner asked for). Do not jump phases unless told to.
2. **Research behaviour.** Before implementing a feature, look up its behaviour in Adobe's public Photoshop User Guide (helpx.adobe.com/photoshop) if you have web access: controls, ranges, defaults, modifier keys, edge cases. Write a short behaviour spec as a comment block at the top of the module or in `docs/specs/<feature>.md`, **in your own words**.
3. **Write tests first** where possible:
   - Unit tests for math (blend modes, adjustments, conversions) against reference values.
   - Golden-image tests: `tests/golden/<feature>/input.*` → run → compare to `expected.png` with a tolerance (ΔE2000 ≤ 1.0 average, ≤ 3.0 max, unless documented). If the owner provides real Photoshop output for a fixture, that becomes the expected image.
   - Playwright E2E for user-facing workflows (select tool → drag → result).
4. **Implement** the smallest complete version. No stubs, no TODO buttons, no "coming soon" dialogs in shipped menus. A menu item either works or is hidden behind a feature flag.
5. **Run everything:** `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e` and `cargo test` for touched crates. Fix all failures before continuing.
6. **Manually verify** in the browser (Playwright screenshot or dev server) for anything visual.
7. **Update `PLAN.md`:** tick `[x]` only when the Definition of Done (§5) is met. If partially done, leave `[ ]` and add a sub-note `↳ partial: …`.
8. **Commit** with a conventional message: `feat(levels): add per-channel input/output and auto options`. One feature per commit.
9. If a decision was non-obvious (algorithm choice, deviation from Photoshop), append it to `docs/DECISIONS.md` with date and reason.

### When you are unsure

- Ambiguous Photoshop behaviour → pick the behaviour from the official docs; if still unclear, implement the most common professional expectation and log it in `docs/DECISIONS.md`.
- Architectural changes, new dependencies with unusual licences, or anything that changes the stack → **stop and ask the owner**.
- Something is genuinely impossible in a browser → log it in `docs/KNOWN_GAPS.md` with the closest achievable alternative, and implement the alternative.

### Never

- Never mark a task done that you haven't run and seen working.
- Never delete or weaken a failing test to make it pass.
- Never leave the app in a non-building state at the end of a session.
- Never put pixel loops on the main thread.
- Never store user images on any server unless the owner enabled a remote AI provider *and* the user explicitly triggered that feature.

---

## 5. Definition of Done (per feature)

A feature is done when **all** of these hold:

- [ ] Works on 8-bit RGB **and** (where Photoshop supports it) 16-bit, 32-bit, CMYK, Lab, Grayscale. If Photoshop greys it out in a mode, we grey it out in that mode too.
- [ ] Respects the active selection (and feathered selections), the active layer/mask/channel target, and lock states.
- [ ] Undoable as a single, correctly named History step. Recordable in Actions and replays identically.
- [ ] Has the same default keyboard shortcut as Photoshop (see §7) and is reachable from the same menu path.
- [ ] Options bar / dialog / Properties panel controls with Photoshop-equivalent ranges and defaults; numeric fields support scrubby sliders, arrow keys (Shift = ×10) and typed math (`+10`, `*2`).
- [ ] Persists in PSD round trip where the format supports it.
- [ ] Unit + golden or E2E tests exist and pass.
- [ ] Performance acceptable on a 6000×4000 16-bit document (preview < 200 ms for live-preview dialogs on a mid-range laptop; final apply runs in a worker with progress).
- [ ] No console errors, no memory leak across 50 repeated applications.

---

## 6. AI features

Photoshop's AI features (Select Subject, Remove tool, Generative Fill/Expand, Neural Filters, Denoise, Sky Replacement, etc.) are part of the scope, but implemented through our own provider abstraction:

```ts
interface AIProvider {
  id: string; local: boolean;
  segment?(img, hint): Promise<Mask>;          // subject, sky, people, objects, hair
  inpaint?(img, mask, prompt?): Promise<Image>;
  generate?(prompt, size, refImage?): Promise<Image>;
  upscale?(img, factor): Promise<Image>;
  depth?(img): Promise<DepthMap>;
  denoise?(img): Promise<Image>;
  // …extend as needed
}
```

- Ship **local, on-device** implementations first (ONNX Runtime Web + WebGPU) using permissively licensed models (verify licence each time; record in `docs/THIRD_PARTY.md`). Models are downloaded on first use with a progress bar and cached in OPFS.
- A **remote provider** (owner-configured endpoint/API key in settings) is optional for generative diffusion features that are too heavy to run locally.
- Every AI result lands on a **new layer** (non-destructive), with variations where Photoshop offers them.
- Each AI feature must have a non-AI fallback where Photoshop has one (e.g. Content-Aware Fill via PatchMatch in WASM before any neural inpainting).

---

## 7. Keyboard shortcuts

Ship a default keymap that matches Photoshop's default shortcut set on both macOS (Cmd/Option) and Windows (Ctrl/Alt), including:

- Single-letter tool keys and Shift+letter to cycle tools within a group (V, M, L, W, C, I, J, B, S, Y, E, G, O, P, T, A, U, H, R, Z, D, X, Q, F).
- Spring-loaded tools: hold a tool key, use it, release to return.
- Space = Hand, Space+Ctrl/Cmd = Zoom, Alt/Option scroll = zoom, `[` `]` brush size, `{` `}` hardness, number keys = opacity (0–9, two digits fast-typed), Shift+number = flow.
- All menu shortcuts (Ctrl/Cmd+N/O/S/Shift+S/Alt+Shift+Ctrl+S/Z/Shift+Z/T/J/E/Shift+E/G/L/M/U/B/I/D/Shift+I, etc.).
- Keyboard Shortcuts editor (Edit > Keyboard Shortcuts) to customise, save and export keymaps.
- The browser intercepts some combos (Ctrl+N, Ctrl+W, Ctrl+T). Handle with: installable PWA mode (where most are capturable), Keyboard Lock API in fullscreen, and documented alternates. Log any unavoidable conflicts in `docs/KNOWN_GAPS.md`.

---

## 8. UI conventions

- Default look: dark charcoal UI with four brightness themes (like Photoshop's interface colour options), 12 px UI font, compact density. Our own visual identity — do not pixel-copy Adobe's UI art.
- Layout: Menu bar → Options bar → Toolbar (left, single/double column) → document tabs → canvas → panel docks (right) → status bar. Panels dock, stack, collapse to icons, float, and are restorable via saved **workspaces**.
- Every dialog with a preview has a **Preview** checkbox, live preview on the canvas, and Alt/Option turns **Cancel** into **Reset**.
- On-canvas HUDs: brush size/hardness (Alt+right-drag / Ctrl+Option+drag), transform readouts, measurement tooltips.
- Accessibility: all panels keyboard-navigable, ARIA labels, respects reduced-motion.

---

## 9. Commands to know

```
pnpm dev             # dev server
pnpm build           # production build (includes wasm build)
pnpm typecheck
pnpm lint
pnpm test            # vitest
pnpm test:golden     # golden-image tests
pnpm test:e2e        # playwright
pnpm wasm            # build Rust crates to wasm
cargo test -p <crate>
```

Create these scripts in Phase 0 if they don't exist yet.

---

## 10. Session start / end checklist

**Start:** read this file → read `PLAN.md` "Current status" → `git log -10` → run tests → continue with next unchecked task.

**End:** all tests pass → app builds → `PLAN.md` updated (ticks + "Current status" section: what was done, what's next, any blockers) → commit.
