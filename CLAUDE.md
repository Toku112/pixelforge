# CLAUDE.md — How to work on this project

> Read this file completely at the start of every session. Then read `PLAN.md`.
> `PLAN.md` is the source of truth for *what* to build. This file is the source of truth for *how* to build it.
> The owner is not a programmer: explain decisions in plain language with examples, and only ask what truly needs them.

---

## 1. Mission

Build **PixelForge** (working title — the owner may rename it; keep the name in one constant, `APP_NAME` in
`src/app/Brand.h`) — a **native desktop app for a 3D artist**: a **node-based compositor for multi-layer OpenEXR render
passes, stills and animations**, with the **full Photoshop-equivalent toolset** built in for painting, retouching and
selections.

The two goals, in priority order:

1. **Composite render passes and push CG renders to photographic realism** — the user renders with **Blender/Cycles,
   Redshift and Octane**.
2. **Never need Photoshop for anything else** — every Photoshop (2026 / v27.x) tool, menu command, panel, adjustment,
   filter, blend mode and layer style in `PLAN.md` exists and produces visually equivalent results.

"Photoshop-equivalent" means:

- A Photoshop user can work without relearning: same menu structure, same tool groupings, same **default keyboard
  shortcuts**, same panel names, same modifier-key behaviours (Shift = constrain/add, Alt/Option = subtract/from
  centre/sample, Ctrl/Cmd = temporary Move, etc.).
- PSD/PSB files open and save with layers, groups, masks, adjustment layers, smart objects, text and layer styles kept,
  so they round-trip with real Photoshop (through the **layer view**, §3.4).
- It is usable professionally: huge multi-layer EXRs, long sequences, scene-linear float, OCIO, ICC/CMYK print, fast
  and stable.

### 1.1 Platforms

- **macOS on Apple Silicon is the primary platform.** Develop and test there first. Minimum: macOS 14.
- **Windows 10/11 (x64)** and **Linux (x64, Ubuntu 22.04+ / equivalent)** must also build, run and pass tests. The
  owner's second machine is Windows with an NVIDIA GPU.
- **No NVIDIA-only code paths.** Every feature must work through the cross-platform GPU layer or on the CPU. Optional
  CUDA/OptiX acceleration may come much later as an extra, never as a requirement.

### 1.2 Legal and brand rules (non-negotiable)

Functional compatibility is the goal. Copying protected expression is not. Therefore:

- **Never** use the names "Adobe", "Photoshop", "Firefly", "Creative Cloud" or Adobe logos anywhere in the product UI,
  app name, icons, splash screens, file names, bundle identifiers or marketing copy. The same goes for other vendors'
  product names (e.g. Nuke, Fusion, After Effects) in our UI. Descriptive references are fine in docs and settings:
  "PSD file format", "Photoshop-compatible shortcuts", "Blender/Cycles pass names", "Redshift AOV preset".
- **Draw all icons ourselves** (or start from a permissively licensed set such as Lucide/Tabler and customise). Never
  extract, trace or screenshot Adobe (or other vendors') icons, cursors, splash art, sample images or brush thumbnails.
- **Do not copy text** from Adobe's or other vendors' help pages into the code or UI (tooltips, dialog help text).
  Write our own wording. Use their documentation only as a *behavioural reference* (what a control does, its range,
  its default).
- Do not bundle Adobe presets, ABR brushes, patterns, gradients, LUTs, Camera Raw profiles or fonts. Create our own
  defaults. Users may **import** their own files (ABR, PAT, GRD, ASL, ASE, CUBE, ATN) — writing importers is fine.
- Do not include Pantone or other licensed colour libraries. Support importing ASE/ACO swatch files instead.
- **Licences.** Check the licence of every dependency, every ML model and every bundled OCIO config, LUT or profile
  before adding it, and record it in `docs/THIRD_PARTY.md`.
  - Allowed by default: MIT, BSD-2/3-Clause, Apache-2.0, ISC, Zlib, BSL-1.0, MPL-2.0 (as a separate module).
  - LGPL (2.1 or 3): only **dynamically linked**, unmodified or with our modifications published, and only for
    components the owner approved (Qt 6 and an LGPL build of FFmpeg are approved — see `docs/DECISIONS.md`). Ask
    before adding any other LGPL component.
  - GPL, AGPL, non-commercial, "research only" or unknown licences: **stop and ask the owner** before adding,
    including build-time tools whose output ends up in the app.

---

## 2. Tech stack (decided — propose changes only with good reason, and ask first)

| Concern | Choice | Notes |
|---|---|---|
| Language | **C++20** | Warnings as errors; ASan/UBSan in debug builds; clang-format + clang-tidy |
| Build | **CMake** (presets) + **vcpkg** manifest mode with a pinned baseline | Conan was the alternative (D-059) |
| UI | **Qt 6 Widgets**, LGPL, **dynamically linked** | Dockable/floating panels, workspaces, Photoshop-style menus and shortcuts (Cmd on Mac, Ctrl on Windows/Linux) |
| GPU | **One cross-platform layer over Metal, D3D12 and Vulkan, shaders written once.** Candidates: **Qt RHI** or **Dawn**. Chosen by the owner after the Phase 0 spike (PLAN Part C). | All GPU work goes through our own thin `gpu::` interface so the backend can change |
| Threads | **oneTBB** task scheduler (D-061) | I/O, decode, evaluation and caching run off the UI thread |
| EXR | **OpenEXR ≥ 3.4.14** + **Imath** | All compressions incl. HTJ2K, multi-part, deep read, data vs display window. 3.4.14 has the HTJ2K security fixes |
| Other images | **OpenImageIO** | TIFF, PNG, JPEG, DPX, HDR, etc. PSD through our own codec (Phase 9) |
| Colour (scene) | **OpenColorIO 2.x** | ACES 2.0 + AgX configs bundled if licences allow; user configs |
| Colour (print) | **lcms2** | ICC v2/v4, CMYK, soft proofing, all intents, black point compensation |
| Denoise | **Open Image Denoise** | CPU + Metal (Apple Silicon) + other GPU backends; uses albedo/normal passes |
| Text | **HarfBuzz + FreeType** | System fonts via CoreText / DirectWrite / fontconfig |
| Video | **FFmpeg (LGPL build)** + **VideoToolbox** on Mac for hardware ProRes | No `--enable-gpl`, no `--enable-nonfree` |
| ML inference | **ONNX Runtime** (CoreML on Mac, DirectML on Windows, CPU everywhere) | All AI features go through `AIProvider` (§6) |
| Plugins | **OpenFX** host (later) | |
| Tests | **GoogleTest** (D-060) + golden-image float comparisons + integration tests driving the app headless | |

Do not add a dependency that is not in this table without asking the owner.

---

## 3. Architecture rules

These rules exist because a compositor plus a Photoshop-class editor collapses under its own weight if they are broken.
Follow them strictly.

### 3.1 Layered architecture

```
CMakeLists.txt  CMakePresets.json  vcpkg.json
src/
  app/        # main(), Brand.h (APP_NAME), service wiring, startup
  core/       # PURE model. Standard library + Imath only. No Qt, no GPU, no OS APIs. Fully unit-testable.
    image/    # float images, named channel sets, tiles, ROI, data window vs display window
    graph/    # nodes, ports, parameters, DAG, evaluation requests, cache keys (hashes)
    anim/     # time, frame ranges, keyframes, curves, interpolation
    commands/ # every mutation is a Command (3.6)
    history/  # undo/redo, History panel model, snapshots
    actions/  # action recording/playback, descriptor format
    layers/   # layer view model: a linear part of the graph shown as a Photoshop-style stack (3.4)
    selection/ paths/ text/   # Photoshop document concepts used by the Paint/Retouch node
    project/  # our project file format (graph, settings, file links)
  color/      # OCIO and lcms2 wrappers, colour-space detection, display transforms
  engine/     # scheduler, thread pool use, node result cache, RAM frame cache, disk cache, memory budget
  nodes/      # one folder per node type: CPU reference implementation (+ GPU implementation), parameters, tests
  tools/      # one folder per Photoshop tool used inside the Paint/Retouch node (logic + options, UI-agnostic)
  gpu/        # our thin GPU interface + the chosen backend; texture pool; uploads/downloads
  io/         # format registry; EXR; OIIO bridge; sequences; renderer presets; PSD; video (FFmpeg/VideoToolbox)
  ui/         # Qt Widgets: main window, menus, docks, node view, layer view, viewer, timeline, panels, dialogs
  ai/         # AIProvider interface + ONNX Runtime implementations + optional remote provider
  plugins/    # OpenFX host (later), scripting host (later)
shaders/      # written once; compiled for Metal, D3D12 and Vulkan by the build
tests/  unit/  golden/  integration/  fixtures/
spikes/       # throw-away experiments (e.g. the GPU spike). Never linked into the app.
docs/   THIRD_PARTY.md  DECISIONS.md  FORMAT_NOTES.md  KNOWN_GAPS.md  specs/
```

- `core/` never includes Qt, GPU, `io/` or `ui/` headers. `ui/` changes the model only through Commands and reads it
  through read-only accessors.
- Nodes and tools are UI-agnostic; their panels in `ui/` are generated from their parameter definitions where possible.

### 3.2 Scene-linear float is the native working space

- All maths happens on **scene-linear float32**, with **no clipping above 1.0** and negative values preserved unless a
  node explicitly clamps (and says so in its UI).
- 8-bit and 16-bit (and half float) exist **only for import/export and for Photoshop-style documents** (a Paint node or
  layer view set to 8/16-bit behaves like Photoshop in that bit depth). Conversion happens at the boundary.
- Images carry **any number of named channels** (e.g. `diffuse_direct.R`, `CryptoObject00.G`, `Z`), not just RGBA.
  Alpha is premultiplied inside the engine (compositing convention); straight alpha only at I/O and in Photoshop-style
  documents where Photoshop maths needs it. Document every conversion in `docs/FORMAT_NOTES.md`.
- Images have a **data window** (where pixels exist) and a **display window** (the frame), exactly like EXR. Nodes
  propagate both; pixels outside the display window are kept, not cropped.
- Photoshop colour modes (RGB, CMYK, Lab, Grayscale, Duotone, Indexed, Bitmap, Multichannel) are first-class for
  Photoshop-style documents. Do **not** fake CMYK by storing RGB. Blend modes and adjustments use Photoshop's maths in
  the document's mode; document every formula in `docs/FORMAT_NOTES.md`.

### 3.3 OpenColorIO everywhere

- Ship with an **ACES 2.0** config and a **Blender-compatible AgX** config — only if their licences allow (see
  THIRD_PARTY). The user can load the OCIO config their renderer uses; `$OCIO` is honoured.
- **View transforms change only what is displayed, never the pixel data.** Export can bake a view transform only when
  the user picks that option.
- Every input (Read node, image, sequence) has a **colour-space setting**, auto-detected from EXR metadata (e.g.
  `chromaticities`, renderer-specific attributes, file naming rules in the config) where possible, always overridable.
- Display: OCIO's GPU shader path on the viewer; HDR/EDR output on Mac where available. ICC (lcms2) handles print,
  CMYK documents and monitor profiles for Photoshop-style work.

### 3.4 The engine is a node graph, with two views

- **Pull-based DAG evaluated per frame.** A request is (node, frame, region of interest, channels, proxy scale).
  Evaluation is **tiled** and limited to the ROI; nodes report the region they need from their inputs.
- **Node result caching** keyed by a hash of the node's parameters at that frame and its inputs' hashes. Changing one
  parameter invalidates only what depends on it.
- **Every parameter can be keyframed.** Parameters are typed (float, int, bool, colour, vector, enum, curve, string,
  file) and animatable through `core/anim`.
- Every node has a **CPU reference implementation**; GPU implementations must match it within tolerance (golden tests
  compare both).
- **Node view** shows the full graph for complex comps. **Layer view** shows a linear part of the same graph as a
  Photoshop-style layer stack — blend modes, opacity, fill, masks, adjustment layers, groups. Editing either view edits
  the same graph; nothing is duplicated.
- **Paint/Retouch node** hosts the Photoshop toolset (brushes, clone stamp, healing, selections, masks). Each stroke
  applies to **a single frame, a frame range, or all frames**, and is stored as a replayable descriptor (not only as
  pixels), so it can be re-applied when the input re-renders.

### 3.5 Timeline and big data

- Real-time playback from a **RAM frame cache**, plus a **disk cache**; dope sheet and curve editor; in/out points;
  A/B wipe between versions or frames.
- **Lazy per-channel EXR loading**: only the channels a graph actually reads are decoded.
- **Memory budget** in Preferences (default 60% of physical RAM), shared by the frame cache, node cache and tiles;
  least-recently-used data is evicted (to the disk cache where worth it).
- **The UI thread never does pixel work or file I/O and never blocks for more than 16 ms.** Long operations run in the
  background with a progress bar and are cancellable with Esc.
- **Live file linking:** when frames are re-rendered on disk, affected inputs reload automatically and all grades stay.

### 3.6 Everything is a Command

- Every change to a project (graph edit, parameter change, keyframe, paint stroke, layer rename, blend mode…) is a
  `Command` with `do()`, `undo()`, a serialisable **descriptor** (name + parameters as JSON) and a human-readable
  history label ("Brush Tool", "Levels", "Free Transform", "Set Exposure").
- This one rule gives us undo/redo, the History panel, **Actions recording** (record descriptors, replay them),
  scripting, batch processing and crash-recovery journaling. Do not bypass it "just this once".
- Continuous edits (dragging a slider) coalesce into one history step. Pixel commands store undo data as **tile
  diffs**, never whole-image copies.

### 3.7 Files

- **Our own project file format** stores the node graph, parameters, keyframes, paint descriptors, settings and file
  links (relative paths where possible). It is versioned and documented in `docs/FORMAT_NOTES.md`.
- **PSD/PSB import/export** maps to and from the layer view. **Multi-layer EXR export** is available for any node.

### 3.8 Non-destructive first

Grades, effects, masks, adjustment layers, smart objects, smart filters, layer styles and live shapes stay editable
after save/reopen. If an operation would destroy editability (rasterize, merge, bake), it must be explicit and
undoable, as in Photoshop.

---

## 4. How to work (your loop)

Repeat this loop for every task:

1. **Pick the next task.** Open `PLAN.md`, go to the current phase, take the first unchecked `[ ]` item (or the item
   the owner asked for). Do not jump phases unless told to.
2. **Research behaviour.** For Photoshop features, read Adobe's public Photoshop User Guide
   (helpx.adobe.com/photoshop): controls, ranges, defaults, modifier keys, edge cases. For compositing features, read
   public docs of the renderers (Blender manual, Redshift and Octane docs — for pass/AOV names and EXR layouts), of
   OpenEXR/OCIO/ACES, and of established compositors as behavioural references. Write a short behaviour spec as a
   comment block at the top of the module or in `docs/specs/<feature>.md`, **in your own words**.
3. **Write tests first** where possible:
   - Unit tests (GoogleTest) for maths (blend modes, grades, colour conversions, keyframe interpolation) against
     reference values.
   - Golden-image tests: `tests/golden/<feature>/` inputs → run → compare to the expected EXR in float, per channel,
     with a tolerance (default: max absolute error ≤ 1e-4 for values ≤ 1, relative ≤ 1e-4 above 1; ΔE2000 ≤ 1.0
     average / ≤ 3.0 max on the display-referred result for Photoshop-style 8/16-bit features), unless documented.
     If the owner provides real reference output (Photoshop, a renderer's beauty pass), that becomes the expected image.
   - Integration tests for user workflows, driving the app headless (open sequence → build graph → render → compare).
4. **Implement** the smallest complete version. No stubs, no TODO buttons, no "coming soon" dialogs in shipped menus.
   A menu item either works or is hidden behind a feature flag.
5. **Run everything** for your platform preset: configure, build, `ctest` (unit + golden + integration), clang-tidy and
   the licence check. Fix all failures before continuing. CI must also pass on Windows and Linux.
6. **Manually verify** anything visual by running the app (screenshots of the viewer, the panel, the result).
7. **Update `PLAN.md`:** tick `[x]` only when the Definition of Done (§5) is met. If partially done, leave `[ ]` and
   add a sub-note `↳ partial: …`; for scope notes on a ticked item use `↳ note: …`.
8. **Commit** with a conventional message: `feat(lightmix): per-group exposure, temperature and mute/solo`. One
   feature per commit.
9. If a decision was non-obvious (algorithm choice, deviation from Photoshop or renderer behaviour), append it to
   `docs/DECISIONS.md` with date and reason.

### Owner checks

Some phase exits need the owner (real Photoshop, real renders, a tablet, the Windows machine). Prepare them in
`docs/phaseN-check/README.md`: short, numbered, plain-language steps and what to look for. Give install steps one at a
time, copy-paste ready, then verify they worked.

### When you are unsure

- Ambiguous Photoshop or renderer behaviour → follow the official docs; if still unclear, implement the most common
  professional expectation and log it in `docs/DECISIONS.md`.
- Architectural changes, new dependencies, unusual licences, anything that changes the stack → **stop and ask the
  owner**, explaining the choice in plain language with an example.
- Something genuinely impossible on a platform → log it in `docs/KNOWN_GAPS.md` with the closest achievable
  alternative, and implement the alternative.

### Never

- Never mark a task done that you haven't run and seen working.
- Never delete or weaken a failing test to make it pass.
- Never leave the app in a non-building state at the end of a session (on any of the three platforms' CI).
- Never do pixel work or file I/O on the UI thread.
- Never clip or quantise scene-linear data unless the user asked for it.
- Never add an NVIDIA-only (or any vendor-only) required code path.
- Never send user images anywhere unless the owner enabled a remote AI provider *and* the user explicitly triggered
  that feature.

---

## 5. Definition of Done (per feature)

A feature is done when **all** of these that apply hold (for infrastructure tasks, see D-006: the applicable items are
enforced, the others are stated as N/A in the PLAN note or commit message):

- [ ] **Float-correct on scene-linear data:** no clipping above 1.0, negatives handled, alpha/premultiplication correct,
  works with arbitrary named channels where it makes sense.
- [ ] **OCIO-correct:** operates in the right colour space (working space, or the space the control is defined in, e.g.
  grading in ACEScct), never bakes the view transform unless asked, respects each input's colour-space setting.
- [ ] **Works on sequences and is keyframable** where it makes sense: every parameter animatable, results cached per
  frame, renders identically in the render queue.
- [ ] Works on Photoshop-style documents in 8/16/32-bit and in CMYK, Lab and Grayscale where Photoshop supports it. If
  Photoshop greys it out in a mode, we grey it out too.
- [ ] Respects the active selection (and feathered selections), masks, the active layer/channel target and lock states.
- [ ] Undoable as a single, correctly named History step. Recordable as an Action and replays identically.
- [ ] Same default keyboard shortcut as Photoshop (§7) and reachable from the same menu path; compositor features get a
  sensible menu path and shortcut, logged in DECISIONS.
- [ ] Panel / dialog / Properties controls with Photoshop-equivalent ranges and defaults; numeric fields support scrubby
  sliders, arrow keys (Shift = ×10) and typed maths (`+10`, `*2`).
- [ ] Persists in our project file, and in PSD or EXR where the format supports it.
- [ ] Unit + golden or integration tests exist and pass on macOS, Windows and Linux (CI). CPU and GPU paths agree.
- [ ] Performance: interactive preview < 100 ms at 1080p (or a proxy scale) for live parameters; < 200 ms for
  Photoshop-style live-preview dialogs on a 6000×4000 16-bit document; heavy work runs in the background with progress
  and Esc to cancel. Measured on Apple Silicon (base M-series) first.
- [ ] No warnings, no sanitizer errors, no memory growth across 50 repeated applications.

---

## 6. AI features

Photoshop's AI features (Select Subject, Remove tool, Generative Fill/Expand, Neural Filters, Denoise, Sky Replacement,
etc.) are in scope, implemented through our own provider abstraction:

```cpp
class AIProvider {
public:
    virtual std::string id() const = 0;
    virtual bool isLocal() const = 0;
    virtual std::optional<Mask>     segment(const Image&, const SegmentHint&) { return {}; } // subject, sky, people, hair
    virtual std::optional<Image>    inpaint(const Image&, const Mask&, std::string_view prompt = {}) { return {}; }
    virtual std::optional<Image>    generate(std::string_view prompt, Size, const Image* ref = nullptr) { return {}; }
    virtual std::optional<Image>    upscale(const Image&, int factor) { return {}; }
    virtual std::optional<DepthMap> depth(const Image&) { return {}; }
    // …extend as needed; all calls run in the background, report progress and can be cancelled
};
```

- Ship **local, on-device** implementations first (ONNX Runtime with CoreML/DirectML/CPU) using permissively licensed
  models (verify each licence; record in `docs/THIRD_PARTY.md`). Models download on first use with a progress bar and
  are cached in the app's data folder.
- A **remote provider** (owner-configured endpoint/API key in Preferences) is optional for generative features too heavy
  to run locally.
- Every AI result lands on a **new layer or a new node** (non-destructive), with variations where Photoshop offers them.
- Each AI feature has a non-AI fallback where Photoshop has one (e.g. Content-Aware Fill via PatchMatch before neural
  inpainting). Denoise of renders uses Open Image Denoise, which is not an `AIProvider` concern.

---

## 7. Keyboard shortcuts

Ship a default keymap matching Photoshop's default set on macOS (Cmd/Option) and Windows/Linux (Ctrl/Alt), including:

- Single-letter tool keys and Shift+letter to cycle tools within a group (V, M, L, W, C, I, J, B, S, Y, E, G, O, P, T,
  A, U, H, R, Z, D, X, Q, F).
- Spring-loaded tools: hold a tool key, use it, release to return.
- Space = Hand, Space+Ctrl/Cmd = Zoom, Alt/Option + scroll = zoom, `[` `]` brush size, `{` `}` hardness, number keys =
  opacity (0–9, two digits typed fast), Shift+number = flow.
- All menu shortcuts (Ctrl/Cmd+N/O/S/Shift+S/Alt+Shift+Ctrl+S/Z/Shift+Z/T/J/E/Shift+E/G/L/M/U/B/I/D/Shift+I, etc.).
- Keyboard Shortcuts editor (Edit > Keyboard Shortcuts) to customise, save and export keymaps.
- **Shortcut contexts:** the viewer/canvas follows Photoshop; the node view, timeline and curve editor have their own
  contexts with compositor shortcuts (playback, frame stepping, keyframes, node creation). When a key means different
  things in two contexts, the focused panel decides; every such choice is logged in `docs/DECISIONS.md`.
- Use Qt's portable key handling (Ctrl in code = Cmd on macOS). macOS system shortcuts the OS keeps (e.g. Cmd+Space,
  Cmd+Tab) are logged in `docs/KNOWN_GAPS.md` with alternates.

---

## 8. UI conventions

- Default look: dark charcoal UI with four brightness themes (like Photoshop's interface colour options), compact
  density, UI scaling. Our own visual identity — do not pixel-copy Adobe's UI art.
- Layout: menu bar (the macOS global menu bar on Mac) → options bar → toolbar (left) → document/comp tabs → viewer →
  panel docks (right) → node view / layer view / timeline (bottom or tabbed) → status bar. Panels dock, stack, collapse
  to icons, float (also onto a second monitor) and are restorable via saved **workspaces** (including our own
  "Compositing", "Paint", "Photography" workspaces next to Photoshop-like ones).
- Every dialog with a preview has a **Preview** checkbox and live preview in the viewer; Alt/Option turns **Cancel**
  into **Reset**.
- Viewer HUDs: brush size/hardness (Alt+right-drag / Ctrl+Option+drag), transform readouts, measurement tooltips,
  float pixel readouts.
- Accessibility: all panels keyboard-navigable, accessible names on controls, respects reduced motion.

---

## 9. Commands to know

Created in Phase 0 (until then they do not exist). Preset names per platform: `macos-debug`, `macos-release`,
`windows-debug`, `windows-release`, `linux-debug`, `linux-release`.

```
cmake --preset macos-debug                 # configure (vcpkg installs dependencies on first run)
cmake --build --preset macos-debug         # build
ctest --preset macos-debug                 # all tests (unit + golden + integration)
ctest --preset macos-debug -L golden       # golden-image tests only
cmake --build --preset macos-debug --target run          # build and start the app
cmake --build --preset macos-debug --target check-licenses
cmake --build --preset macos-debug --target format       # clang-format
cmake --build --preset macos-release --target package    # app bundle / installer
```

---

## 10. Session start / end checklist

**Start:** read this file → read `PLAN.md` "Current status" → `git log -10` → build and run the tests → continue with
the next unchecked task.

**End:** all tests pass → app builds → `PLAN.md` updated (ticks + "Current status": what was done, what's next, any
blockers) → commit. If the session has been long, suggest the owner starts a fresh chat after the commit.
