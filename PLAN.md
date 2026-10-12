# PLAN.md — Feature inventory and build roadmap

> What we build: a native node-based compositor for multi-layer EXR render passes (stills and animations) with the full
> Photoshop-equivalent toolset built in. Read `CLAUDE.md` first.
> Photoshop reference: **Photoshop 2026 (desktop v27.x)**, behaviour taken from Adobe's public Photoshop User Guide.
> Tick `[x]` only when the Definition of Done in `CLAUDE.md §5` is met. Partial work gets `↳ partial: …`, scope notes on
> ticked items get `↳ note: …`.
> Items marked **(AI)** go through the `AIProvider` interface (CLAUDE.md §6).

---

## Current status

_Update this section at the end of every session._

- **2026-10-12 — change of direction.** The browser prototype (Phases 0–2 of the old plan: tiled document model,
  WebGL compositor, layers, selections, the whole brush engine and painting tools, basic PSD) is archived on the git
  branch `archive/web-prototype` with its full history. `main` holds only the docs. Why and what was removed:
  `docs/DECISIONS.md` D-054 to D-069.
- Phase: **0 — Foundation, started 2026-10-12** (owner approved the new docs; approvals in D-068).
- Done: Part C item 1 on the Mac (toolchain installed by the owner; the Windows machine follows later in the phase).
  vcpkg has ports for OpenEXR 3.5.2, OpenColorIO 2.6.0, OpenImageIO 3.1, oneTBB, lcms2, HarfBuzz, FreeType, FFmpeg,
  GoogleTest and Dawn; Open Image Denoise has no port (official prebuilt releases or an overlay port, Phase 2).
- Done: item 2, the GPU-layer spike (`docs/specs/gpu-spike.md`). The owner chose **Qt RHI** (D-069). The Windows
  check of that choice is part of item 1's Windows half.
- Done: item 3, the repository skeleton (build presets, dependency manifest, folder layout, licence and layering
  checks, format/tidy/run/package targets). The owner installed LLVM 21 and allowed CC0-1.0 and 0BSD (D-071).
- Done: item 4 (2026-10-12) — GoogleTest with unit/golden/integration labels, the golden-image harness, an app
  startup test, and CI on GitHub (https://github.com/Toku112/pixelforge, public): macOS, Windows and Linux all green,
  49/49 tests in debug and release. Commits use the owner's GitHub private e-mail address (history rewritten before
  the first push, owner's choice).
- Done: item 5 (2026-10-12) — the float image core (`src/core/image`, FORMAT_NOTES §19, D-073); tile size 256 × 256
  chosen by measurement (`spikes/tile-size`).
- Done: item 6 (2026-10-12) — engine services (`src/engine`, D-074): job scheduler with viewer > caching > render
  priorities, cancellation, progress, memory budget with LRU caches, tile pool (measured in `spikes/tile-alloc`).
- Next up: item 7 (node graph core: nodes, ports, parameters, keyframes, pull evaluation, node result cache; first
  nodes Read, Viewer, Shuffle, Exposure).
- Blockers: sample renders from Cycles (Phase 0), Redshift and Octane (Phase 1) for test fixtures (Part C item 15).

---

# PART A — ROADMAP (build order)

Build in this order. Each phase ends with a working, releasable app on macOS (Apple Silicon), with Windows and Linux
building and passing tests in CI. Do not start a phase until the previous phase's exit criteria pass. Each phase gets
its own task list (Part C for Phase 0, then Part D, E, …) written when it starts.

| Phase | Goal | Exit criteria |
|---|---|---|
| **0. Foundation** | Native Qt shell; the chosen GPU layer; float images and tiles; node graph core; command/undo; OCIO viewer; EXR still + sequence reading; RAM playback cache | Open a Cycles multi-layer EXR sequence, play it in real time at 1080p from cache with the AgX view, scrub frames, and view any AOV |
| **1. Render comp MVP** | Render Stack / AOV rebuild; light group mixer; Cryptomatte and ID mattes; merge/blend nodes (all Photoshop blend modes); grade nodes; layer view; project file; EXR/PNG sequence + ProRes export | Rebuild a Cycles, a Redshift and an Octane beauty from passes (difference ≈ 0), regrade light groups and an object picked by Cryptomatte, save/reopen the project, export an EXR sequence and a ProRes movie |
| **2. Realism toolkit** | Z-depth defocus, glare/bloom (FFT), lens effects, vector motion blur, depth atmosphere, relighting, film/sensor emulation, grain matching, light wrap, OIDN denoise, full grading (CDL, ACEScct, curves, hue-vs, LUTs) | Take a raw Cycles render to a photographic final using only these nodes; every effect keyframable and identical in the render queue |
| **3. Paint/Retouch node** | Core Photoshop tools inside a Paint/Retouch node: selections (marquee, lasso, magic wand, quick selection), brush engine, eraser, clone stamp, healing brush, spot healing, masks; per-frame / frame-range / all-frames strokes; basic PSD import/export of the layer view | Remove a firefly on one frame, paint out a wire across a frame range, clone-fix a texture seam on all frames; round-trip a layered still through PSD with real Photoshop |
| **4. Animation depth** | Curve editor, dope sheet, 2D tracker (stabilise, attach paint fixes), render queue with multiple jobs, disk cache, A/B wipe of versions, live file linking polish | Track a point through a shot, attach a paint fix to it, animate a grade with eased keys in the curve editor, queue three renders overnight |
| **5. Adjustments** | Every Photoshop adjustment as a node, a destructive command and an adjustment layer; Properties, Histogram and Info panels; fill layers | Full photographic colour-grading workflow on stills and sequences, float-correct |
| **6. Selections, masks & channels** | All remaining selection tools, Select and Mask, Color Range, Focus Area, Quick Mask, vector and clipping masks, channels and alpha channels | Complex cut-out (hair) achievable without AI, on a still and on a sequence frame |
| **7. Filters** | Every Photoshop filter incl. Filter Gallery, Blur Gallery, Liquify, Lens Correction, Adaptive Wide Angle, Vanishing Point — as nodes and smart filters | All Filter menu items work, as smart filters too, float-correct where Photoshop supports 32-bit |
| **8. Retouching & transforms** | Full healing family, Clone Source panel, Content-Aware Fill/Scale/Move, Puppet/Perspective Warp, Warp, Auto-Align/Blend, Photomerge, Merge to HDR | Professional retouching workflow on stills; content-aware fill across a frame range |
| **9. Colour management, modes & formats** | lcms2 ICC pipeline, all Photoshop colour modes and bit depths, soft proofing, our own full PSD/PSB codec, TIFF/PDF and the rest of the format table | Pre-press CMYK job; 16-bit and 32-bit documents round-trip with Photoshop |
| **10. Vector & type** | Pen tools, paths, shape layers and live shapes, full type engine (HarfBuzz/FreeType) | Design a poster with editable text and shapes that round-trips as PSD |
| **11. Layer styles & smart objects** | All 10 effects + blending options, Styles panel, smart objects (embedded/linked), smart filters, layer comps, artboards | Non-destructive design workflow; a smart object can hold a comp |
| **12. Raw development** | Camera-Raw-equivalent module (as dialog and as filter) | Edit a camera RAW end-to-end |
| **13. Automation & extensibility** | Actions panel (+ATN import), Batch, Droplets, Image Processor, scripting API, OpenFX host, Blender add-on ("send to comp", render-output watch) | Batch-process 500 images via a recorded action; run an OpenFX plugin as a node |
| **14. AI features** | Select Subject/Sky/People, Remove tool, Generative Fill/Expand, neural-filter equivalents, upscale, Sky Replacement | AI features run locally (or via a configured provider) on new layers/nodes |
| **15. Output, print, preferences & polish** | Export As / Save for Web, slices, frame animation and GIF, Print, all Preferences, workspaces, shortcut editor, menu/toolbar customisation, onboarding, installers, performance hardening | Pro user beta on macOS and Windows with real-world renders and PSDs |

Which phase completes which Part B section: B0 → Phases 0–4 (each B0 item names its phase); B1, B15, B16, B21 grow in
every phase and finish in 15; B2 tools → 3 (core), 6, 8, 10; B3/B4 → spread, finished in 15; B5 → 5 and 9; B6 → 1 (layer
view), 3, 11; B7 → 5; B8 → 1; B9 → 3; B10 → 11; B11 → 3 (core), 6; B12/B13 → 10; B14 → 7; B17 → 12; B18 → 4 and 15;
B19 → 13; B20 → 9 and 15; B22 → 0–1 (EXR), 3 (basic PSD), 9; B23 → 8; B24 → 15; B25 → all.

---

# PART B — COMPLETE FEATURE INVENTORY

The browser prototype implemented parts of B2, B3, B5, B6, B8, B9 and B16 (see the archive branch). Nothing of it is on
`main`, so every item starts unticked. When those features are rebuilt, the prototype's behaviour decisions
(`docs/DECISIONS.md` D-020 to D-053) and maths (`docs/FORMAT_NOTES.md` §3–§17) are the starting reference.

## B0. Render compositing & realism (top priority)

### B0.1 Compositor core & UI
- [ ] Node graph: pull-based DAG per frame, ROI/tiled evaluation, proxy scales, node result cache, cancellation and progress (Phase 0)
- [ ] Every parameter keyframable; linear/constant/smooth/Bézier keys (Phase 0 data model; editors in Phase 4)
- [ ] Node view: create (Tab search menu), connect, disconnect, insert into a wire, select, move, group/backdrop, collapse into a group node, bypass, view node in viewer (number keys / click), viewer A/B inputs (Phase 0 basic, Phase 1 complete)
- [ ] Layer view: a linear part of the graph as a Photoshop-style layer stack — layers, groups, blend modes, opacity/fill, masks, adjustment layers, visibility, locks; edits in either view change the same graph (Phase 1)
- [ ] Read node: still, sequence or movie; colour-space setting auto-detected from metadata; frame range, offset, hold/loop/black for frames outside the range; missing-frame handling; reload (Phase 0)
- [ ] Project file: graph, parameters, keyframes, paint descriptors, viewer/workspace state, relative file links; versioned; autosave and crash recovery (Phase 1)
- [ ] OCIO: bundled ACES 2.0 and Blender-compatible AgX configs (licences permitting), load any config, `$OCIO`, per-input colour space, working space setting, display/view menus in the viewer (Phase 0)
- [ ] Merge node with all Photoshop blend modes plus compositing operators (over, under, in, out, atop, xor, plus, minus, multiply, screen, max, min, difference, mask, stencil, copy) on premultiplied float (Phase 1)
- [ ] Shuffle/Copy channels, rename layers, Premult/Unpremult, Transform/Reformat/Crop, Constant, Switch, Dissolve, Dot, Group nodes (Phase 1)

### B0.2 EXR & renderer support
- [ ] Multi-layer and multi-part EXR stills and frame sequences: all compressions (none, RLE, ZIPS, ZIP, PIZ, PXR24, B44, B44A, DWAA, DWAB, HTJ2K), half/float/uint, scanline and tiled, data window vs display window, multi-view (stereo) (Phase 0)
- [ ] Deep EXR read: detect deep parts, flatten to a regular image; full deep compositing later (Phase 1)
- [ ] Lazy per-channel loading: only the channels the graph reads are decoded (Phase 0)
- [ ] Automatic sequence detection, including frame-number patterns (`name.1001.exr`, `name_1001.exr`, `name1001.exr`, `####`, `%04d`, `@@@@`), negative frames, gaps; missing frames reported and shown as held/black/checker (Phase 0)
- [ ] Metadata panel: every EXR header attribute per part (renderer, camera, render time, chromaticities, custom attributes) (Phase 0)
- [ ] Renderer presets that auto-detect and organise passes (Phase 1):
  - [ ] **Blender/Cycles**: view layers, light groups, Cryptomatte, denoising data, pass naming
  - [ ] **Redshift**: AOVs, light groups, Cryptomatte, raw vs filtered AOVs
  - [ ] **Octane**: render passes, light passes, Cryptomatte, info passes
- [ ] Live file linking: when frames are re-rendered on disk, the comp reloads them automatically and keeps all grades (Phase 1, polish in Phase 4)

### B0.3 AOV rebuild
- [ ] Render Stack node: rebuilds the beauty from component passes — diffuse/specular/transmission (direct + indirect, colour/albedo where the renderer splits it), emission, SSS, volume, background/environment, and so on — using the renderer preset's recipe (Phase 1)
- [ ] Per-pass grading inside the Render Stack (exposure, colour, saturation, mute/solo per pass) (Phase 1)
- [ ] Rebuild-check view: difference between the rebuilt and the original beauty, with a numeric error readout (Phase 1)

### B0.4 Light group mixer
- [ ] Per light group: exposure in stops, colour temperature/tint, RGB gain, saturation, mute/solo; keyframable (Phase 1)
- [ ] Works with Cycles light groups, Redshift light-group AOVs and Octane light passes (Phase 1)

### B0.5 Mattes
- [ ] Cryptomatte picker: click to add/remove in the viewer, manifest support (embedded or sidecar), name list with search, wildcards, preview overlay; object/material/asset layers (Phase 1)
- [ ] Object/material ID mattes (index passes, colour IDs) (Phase 1)
- [ ] Position-pass 3D volume mattes: sphere/box/plane in world space with falloff, placed by clicking in the viewer (Phase 2)
- [ ] Normal-pass mattes (direction + falloff) (Phase 2)
- [ ] Depth-range mattes (near/far with falloff) (Phase 2)
- [ ] Luminance and hue keys (Phase 2)
- [ ] All mattes combinable (add/subtract/intersect/invert) and usable as masks on any node (Phase 1 for Cryptomatte/ID, Phase 2 for the rest)

### B0.6 Float viewer
- [ ] Exposure (stops) and gamma view controls; display/view selection from the OCIO config; view transform never touches pixel data (Phase 0)
- [ ] Channel/AOV selector; R/G/B/A/luma views (Phase 0)
- [ ] Float pixel inspector: values under the cursor (scene-linear and display), area average (Phase 0)
- [ ] False colour, clipping (> 1.0) and negative-value warnings, NaN/Inf highlight (Phase 1)
- [ ] A/B wipe and side-by-side between nodes, versions or frames (Phase 1 for nodes, Phase 4 for versions)
- [ ] HDR display output on Mac (EDR) where available; HDR on Windows where the display supports it (Phase 2)
- [ ] Data window / display window overlays, safe areas, region-of-interest box (Phase 1)

### B0.7 Realism toolkit (Phase 2)
- [ ] **Z-depth defocus:** physically based (focal length, f-stop, focus distance, sensor size), bokeh shapes (blades, rotation, custom image), cat-eye, chromatic bokeh, click-to-focus in the viewer, correct foreground/background edges
- [ ] **Glare/bloom:** FFT convolution with aperture shapes (diffraction starbursts from blade count and obstructions), threshold and energy-preserving mix
- [ ] **Lens effects:**
  - [ ] chromatic aberration (lateral and longitudinal)
  - [ ] distortion (barrel/pincushion/anamorphic), ST-map import/export
  - [ ] vignetting (optical and natural, cos⁴)
  - [ ] anamorphic streaks
  - [ ] halation
  - [ ] lens dirt (driven by bright areas)
- [ ] **Motion blur** from the vector pass (Cycles, Redshift and Octane vector conventions), shutter angle, samples
- [ ] **Depth atmosphere:** haze, fog, aerial perspective (distance-based scattering with colour), optional height falloff from the position pass
- [ ] **Relighting** from the normal and position passes: add/remove directional, point and area-like lights, rim lights, using albedo where available
- [ ] **Film and sensor emulation:** luminance-responsive per-channel grain, sensor noise by ISO, film looks (our own)
- [ ] **Grain matching:** measure grain from a reference plate (per channel, by luminance) and reproduce it
- [ ] **CG-into-plate tools:** light wrap, edge softening/blur by matte, edge extend
- [ ] **Denoise** with Open Image Denoise using albedo/normal passes, per pass or on the beauty; CPU and GPU (Metal on Apple Silicon)
- [ ] **Grading:** ASC CDL (with .cdl/.cc/.ccc import/export), lift/gamma/gain/offset, grading in ACEScct (or any log space from the config), curves, hue-vs-hue/sat/lum curves, LUT import/export (.cube, 1D and 3D)

### B0.8 Animation
- [ ] Every grade and effect works across the whole sequence (Phase 1)
- [ ] Keyframes on any parameter; keyframe buttons on every control; auto-key mode (Phase 1 basic, Phase 4 full)
- [ ] Timeline: play, scrub, frame step, in/out points, frame rate, loop modes; RAM frame cache with a cached-frames bar; background caching (Phase 0)
- [ ] Disk cache for frames and heavy node results (Phase 4)
- [ ] Dope sheet and curve editor (Phase 4)
- [ ] Per-frame paint fixes, e.g. removing a firefly on one frame (Phase 3)
- [ ] 2D tracker (point and multi-point; translate/rotate/scale) for stabilising and attaching paint fixes (Phase 4)
- [ ] Planar tracker (later, after Phase 4)

### B0.9 Output
- [ ] Render queue: multiple jobs, any node as output, frame ranges, progress, logs, renders in the background while the UI stays usable (Phase 1 basic, Phase 4 full)
- [ ] EXR sequences: choose compression, which channels/layers, half/float, single- or multi-part, metadata pass-through (Phase 1)
- [ ] PNG/TIFF/DPX sequences, with the view transform baked in or not (Phase 1 PNG, rest Phase 2)
- [ ] ProRes (422 Proxy/LT/422/HQ, 4444, 4444 XQ) via VideoToolbox on Mac and FFmpeg elsewhere; DNxHR; H.264/H.265 (Phase 1 ProRes, rest Phase 2) — see KNOWN_GAPS for H.264/H.265 encoders
- [ ] Stills in all Photoshop formats (with B22, Phase 9)

### B0.10 Nice to have later
- [ ] Blender add-on: "send to comp", watch the render output folder (Phase 13)
- [ ] Deep compositing (deep merge, deep holdout, deep to image)
- [ ] OpenFX plugins (Phase 13)
- [ ] Optional CUDA/OptiX acceleration on NVIDIA (never required)
- [ ] 3D card/camera projection from renderer camera metadata

## B1. Workspace & interface

- [ ] Menu bar: File, Edit, Image, Layer, Type, Select, Filter, View, Plugins, Window, Help (same order and grouping), plus our **Composite** menu (nodes) between Filter and View, and render items under File (D-063); on macOS the app menu holds About/Preferences/Quit as the platform expects
- [ ] Options bar (context-sensitive per tool), with tool preset picker at far left
- [ ] Toolbar: single/double column, tool groups with flyouts, long-press and right-click to open group, Shift+key cycling
- [ ] Edit Toolbar dialog (customise which tools appear, extra tools slot, save presets)
- [ ] Foreground/background colour swatches, swap (X), default (D)
- [ ] Quick Mask mode toggle (Q)
- [ ] Screen modes: Standard, Full Screen with Menu Bar, Full Screen (F to cycle), Tab hides panels
- [ ] Document tabs, floating windows, Arrange (tile all vertically/horizontally/grid, 2-up…6-up, consolidate, match zoom/location/rotation/all), New Window for same document
- [ ] Panel system: dock, stack, group, collapse to icons, float, resize, close, panel menus
- [ ] Workspaces: Essentials, Graphic & Web, Motion, Painting, Photography; New/Delete/Reset workspace; saved custom workspaces
- [ ] Interface colour themes (4 brightness levels), UI scaling, font size
- [ ] Home screen: recent files, new document presets, open
- [ ] Contextual Task Bar (floating bar with next-step suggestions near selection/layer)
- [ ] Status bar: zoom, document info selector (doc sizes, profile, dimensions, measurement scale, efficiency, timing, current tool, 32-bit exposure)
- [ ] In-app search (tools, commands, help)
- [ ] Rich tooltips (our own wording/animations)
- [ ] Discover/learn panel (our own tutorials) — low priority
- [ ] Undo of panel layout changes not required; but workspace auto-save on exit

## B2. Tools (complete toolbar)

### Move & selection
- [ ] Move tool (V): auto-select layer/group, show transform controls, align/distribute buttons in options bar, Alt-drag duplicate, arrow-key nudge (Shift = 10 px), move between documents
- [ ] Artboard tool: create, resize, presets, add adjacent artboards (+ handles)
- [ ] Rectangular Marquee (M): new/add/subtract/intersect, feather, anti-alias, style (normal/fixed ratio/fixed size), Shift square, Alt from centre, Space to reposition while dragging
- [ ] Elliptical Marquee
- [ ] Single Row Marquee
- [ ] Single Column Marquee
- [ ] Lasso (L)
- [ ] Polygonal Lasso (Alt toggles freehand; Backspace removes last point)
- [ ] Magnetic Lasso: width, contrast, frequency, pen pressure, edge snapping
- [ ] Object Selection tool (W) **(AI)**: rectangle/lasso mode, hover object finder, object subtract
- [ ] Quick Selection tool: brush-based edge-aware region growing, sample all layers, enhance edge
- [ ] Magic Wand: tolerance, contiguous, anti-alias, sample all layers, sample size
- [ ] Select Subject button in options bar **(AI)**

### Crop & slice
- [ ] Crop tool (C): ratio/size/resolution presets, straighten, overlays (rule of thirds, grid, diagonal, triangle, golden ratio, golden spiral), delete cropped pixels toggle, content-aware fill on expand, classic mode, crop shield colour/opacity, rotate crop
- [ ] Generative Expand when extending canvas with crop **(AI)**
- [ ] Perspective Crop tool
- [ ] Slice tool
- [ ] Slice Select tool
- [ ] Frame tool (rectangle/ellipse frames that hold placed images)

### Measurement
- [ ] Eyedropper (I): sample size (point, 3×3 … 101×101 average), sample current/all layers, show sampling ring
- [ ] Color Sampler (up to 10 samplers, readouts in Info panel)
- [ ] Ruler tool: distance/angle, Straighten Layer button
- [ ] Note tool
- [ ] Count tool: groups, colours, marker/label size

### Retouching
- [ ] Spot Healing Brush (J): content-aware / create texture / proximity match, sample all layers
- [ ] Remove tool **(AI)**: brush to remove, auto-remove on stroke completion, Find Distractions (wires & cables, people, general distractions), reflection removal
- [ ] Healing Brush: source (sampled/pattern), aligned, sample (current/current & below/all), diffusion
- [ ] Patch tool: normal/content-aware, source/destination, transparent, structure/colour
- [ ] Content-Aware Move tool: move/extend, structure, colour, transform on drop
- [ ] Red Eye tool: pupil size, darken amount
- [ ] Clone Stamp (S): aligned, sample modes, clone source overlay, ignore adjustment layers
- [ ] Pattern Stamp
- [ ] History Brush (Y)
- [ ] Art History Brush: style, area, tolerance
- [ ] Blur tool, Sharpen tool (protect detail), Smudge tool (finger painting)
- [ ] Dodge (O): range shadows/midtones/highlights, exposure, protect tones
- [ ] Burn
- [ ] Sponge: saturate/desaturate, vibrance

### Painting
- [ ] Brush tool (B): see B9 Brush engine
- [ ] Pencil tool: auto erase
- [ ] Color Replacement tool: sampling (continuous/once/background swatch), limits, tolerance
- [ ] Mixer Brush tool: wet, load, mix, flow, load after each stroke, clean after each stroke, sample all layers, presets
- [ ] Eraser (E): brush/pencil/block modes, erase to history
- [ ] Background Eraser: sampling, limits, tolerance, protect foreground colour
- [ ] Magic Eraser
- [ ] Gradient tool (G): live on-canvas gradient (creates gradient fill layer) and classic mode; linear, radial, angle, reflected, diamond; reverse, dither, transparency; method (perceptual, linear, classic, smooth, stripes)
- [ ] Paint Bucket: foreground/pattern, tolerance, contiguous, all layers

### Drawing & type
- [ ] Pen tool (P): shape/path/pixels mode, rubber band, auto add/delete, path operations
- [ ] Freeform Pen tool (magnetic option)
- [ ] Curvature Pen tool
- [ ] Add Anchor Point, Delete Anchor Point, Convert Point tools
- [ ] Horizontal Type (T), Vertical Type, Horizontal Type Mask, Vertical Type Mask
- [ ] Path Selection (A), Direct Selection
- [ ] Rectangle (U) with live corner radii, Ellipse, Triangle, Polygon (sides, star ratio, smooth indents), Line (arrowheads), Custom Shape

### Navigation
- [ ] Hand tool (H), scroll all windows
- [ ] Rotate View tool (R), reset view
- [ ] Zoom tool (Z): scrubby zoom, animated zoom, zoom all windows, resize windows to fit

## B3. File menu

- [ ] New (dialog with category presets: Photo, Print, Art & Illustration, Web, Mobile, Film & Video; saved presets; artboards checkbox; colour mode, bit depth, profile, pixel aspect ratio, background contents)
- [ ] Open, Open As, Open as Smart Object, Open Recent, Browse (native file dialogs, drag-and-drop from Finder/Explorer, a built-in file browser with thumbnails of EXRs and sequences)
- [ ] Close, Close All, Close Others, Close and Go to Home
- [ ] Save, Save As, Save a Copy, Revert (native save dialogs, save in place, safe atomic writes)
- [ ] Version History / autosave & crash recovery (command journal + periodic project snapshots in the app's data folder)
- [ ] Export: Quick Export as PNG, Export As (multiple sizes/suffixes, format, quality, metadata, colour space, canvas size, preview), Export Preferences
- [ ] Export: Save for Web (Legacy) dialog — 2-up/4-up, optimisation per format, colour table, image size, preview in the system web browser
- [ ] Export: Artboards to Files, Artboards to PDF, Layer Comps to Files/PDF, Layers to Files, Color Lookup Tables, Data Sets as Files, Paths to vector file (SVG/AI-compatible path export), Render Video
- [ ] Generate > Image Assets (layer-name-based asset generation)
- [ ] Share (macOS share sheet / Windows share; Reveal in Finder/Explorer)
- [ ] Place Embedded, Place Linked, Package (collect linked files)
- [ ] Automate: Batch, PDF Presentation, Create Droplet (a small launcher app/shortcut that runs a saved batch on dropped files, plus a command-line form), Crop and Straighten Photos, Contact Sheet, Conditional Mode Change, Fit Image, Lens Correction (batch), Merge to HDR Pro, Photomerge
- [ ] Scripts: Image Processor, Delete All Empty Layers, Flatten All Layer Effects, Flatten All Masks, Load Files into Stack, Load Multiple DICOM Files, Statistics (stack modes), Script Events Manager, Browse (run script file), Export Layers to Files
- [ ] Import: Variable Data Sets, Video Frames to Layers, Notes, images from cameras and scanners (macOS Image Capture, Windows WIA)
- [ ] File Info (full XMP metadata editor: basic, camera data, origin, IPTC, IPTC extension, GPS, audio/video data, raw data)
- [ ] Print, Print One Copy (see B20)
- [ ] Content Credentials on export (C2PA manifests; use an open-source C2PA library)

## B4. Edit menu

- [ ] Undo, Redo, Toggle Last State; configurable history states count
- [ ] Fade (opacity + blend mode of last filter/adjustment/paint)
- [ ] Cut, Copy, Copy Merged, Paste, Paste Special (Paste in Place, Paste Into, Paste Outside, Paste without formatting), Clear — integrate with system clipboard (images and text)
- [ ] Search
- [ ] Check Spelling, Find and Replace Text
- [ ] Fill: foreground/background/colour/content-aware/pattern (incl. script patterns: brick fill, cross weave, random fill, spiral, symmetry fill, place along path, picture frame, tree)/history/black/50% gray/white; blending mode, opacity, preserve transparency
- [ ] Stroke: width, colour, location (inside/center/outside), blending
- [ ] Content-Aware Fill workspace: sampling area brush, auto/rectangular/custom sampling, fill settings (colour adaptation, rotation adaptation, scale, mirror), output to new layer/current/duplicate
- [ ] Generative Fill **(AI)**, Generate Image **(AI)**, Generate Background **(AI)**, Generate Similar **(AI)**, reference image, model picker (our providers), variations in Properties panel
- [ ] Content-Aware Scale: protect skin tones, protect alpha channel, amount
- [ ] Puppet Warp: mesh (rigid/normal/distort), density, expansion, pins, pin depth, rotate pins
- [ ] Perspective Warp: layout planes, warp mode, auto straighten
- [ ] Free Transform (Ctrl/Cmd+T): reference point, numeric X/Y/W/H/angle/skew, link aspect (proportional by default, Shift toggles), interpolation choice, Ctrl-drag corner distort
- [ ] Transform submenu: Again, Scale, Rotate, Skew, Distort, Perspective, Warp (presets: arc, arc lower/upper, arch, bulge, shell lower/upper, flag, wave, fish, rise, fisheye, inflate, squeeze, twist, cylinder; custom grid 3×3/4×4/5×5/custom; split warp horizontal/vertical/cross), Rotate 180°, 90° CW, 90° CCW, Flip Horizontal, Flip Vertical
- [ ] Rotate object into new perspective/orientation with on-canvas controls **(AI)**
- [ ] Auto-Align Layers (auto, perspective, collage, cylindrical, spherical, reposition; geometric distortion, vignette removal)
- [ ] Auto-Blend Layers (panorama, stack images / focus stacking; seamless tones; content-aware fill transparent areas)
- [ ] Sky Replacement **(AI)**: sky library (our own skies), shift edge, fade edge, brightness, temperature, scale, flip, foreground lighting/adjustment, output to new layers
- [ ] Define Brush Preset, Define Pattern, Define Custom Shape
- [ ] Purge (clipboard, histories, all, video cache)
- [ ] Presets: Preset Manager, Export/Import Presets, Migrate Presets
- [ ] Color Settings (see B13), Assign Profile, Convert to Profile
- [ ] Keyboard Shortcuts editor, Menus editor (hide/colour menu items), Toolbar editor
- [ ] Preferences (see B21)

## B5. Image menu

- [ ] Mode: Bitmap (50% threshold, pattern dither, diffusion dither, halftone screen, custom pattern), Grayscale, Duotone (mono/duo/tri/quadtone with curves), Indexed Color (palettes: exact, system, web, uniform, perceptual, selective, adaptive, custom, previous; forced colours; transparency; matte; dithering), RGB, CMYK, Lab, Multichannel; 8/16/32 Bits/Channel; Color Table editor
- [ ] Adjustments submenu (all items in B7)
- [ ] Auto Tone, Auto Contrast, Auto Color (with auto colour correction options: algorithms, target shadows/midtones/highlights, clip)
- [ ] Image Size: width/height/resolution, constrain, resample methods (Automatic, Preserve Details 2.0, Preserve Details (enlargement), Bicubic Smoother, Bicubic Sharper, Bicubic, Bilinear, Nearest Neighbor), reduce noise, scale styles, fit-to presets, preview
- [ ] Canvas Size: relative, anchor, extension colour
- [ ] Image Rotation: 180°, 90° CW/CCW, Arbitrary, Flip Canvas H/V
- [ ] Crop (to selection), Trim (transparent/top-left/bottom-right colour, per-side), Reveal All
- [ ] Duplicate image (merged layers only option)
- [ ] Apply Image (source document/layer/channel, invert, blending, opacity, mask)
- [ ] Calculations (two sources → new channel/document/selection)
- [ ] Variables (Define, Data Sets) — data-driven graphics
- [ ] Apply Data Set
- [ ] Trap (CMYK)
- [ ] Analysis: Set Measurement Scale, Select Data Points, Record Measurements, Ruler tool, Count tool, Place Scale Marker; Measurement Log panel

## B6. Layer menu & Layers panel

- [ ] Layer kinds: pixel, background (locked bottom), group (incl. nested, pass through), adjustment, fill (solid/gradient/pattern), type, shape, smart object, video, frame, artboard
- [ ] New: Layer, Background from Layer, Group, Group from Layers, Artboard, Artboard from Group/Layers, Layer via Copy, Layer via Cut
- [ ] Copy CSS, Copy SVG
- [ ] Duplicate Layer/Group (to other document), Delete (incl. hidden layers), Rename
- [ ] Quick Export as PNG, Export As (from layer)
- [ ] Layer Style submenu (see B10)
- [ ] Smart Filter submenu (disable, delete, clear, filter mask)
- [ ] New Fill Layer, New Adjustment Layer, Layer Content Options
- [ ] Layer Mask: Reveal All, Hide All, Reveal/Hide Selection, From Transparency, Delete, Apply, Enable/Disable, Link/Unlink
- [ ] Vector Mask: Reveal All, Hide All, Current Path, Delete, Enable/Disable, Link/Unlink
- [ ] Create/Release Clipping Mask (Alt-click between layers)
- [ ] Smart Objects: Convert to, New via Copy, Edit Contents, Reset Transform, Relink to File/Library, Update Modified/All, Resolve Broken Link, Export Contents, Embed Linked, Convert to Linked, Replace Contents, Stack Mode (Entropy, Kurtosis, Maximum, Mean, Median, Minimum, Range, Skewness, Standard Deviation, Summation, Variance), Rasterize, Convert to Layers
- [ ] Video Layers submenu (see B18)
- [ ] Rasterize: Type, Shape, Fill Content, Vector Mask, Smart Object, Video, Layer, All Layers, Layer Style
- [ ] New Layer Based Slice
- [ ] Group, Ungroup, Hide/Show layers
- [ ] Arrange: Bring to Front, Bring Forward, Send Backward, Send to Back, Reverse
- [ ] Combine Shapes (unite, subtract front, intersect, exclude)
- [ ] Align (top/vertical centre/bottom/left/horizontal centre/right) and Distribute (incl. spacing) — to selection, canvas, key object
- [ ] Lock: transparent pixels, image pixels, position, artboard auto-nest, all
- [ ] Link Layers, Select Linked
- [ ] Merge Layers, Merge Down, Merge Visible, Stamp Visible (Ctrl+Alt+Shift+E), Flatten Image
- [ ] Matting: Color Decontaminate, Defringe, Remove Black Matte, Remove White Matte
- [ ] Layers panel: thumbnails (sizes, layer bounds/entire document), visibility toggles (Alt-click solo), blend mode & opacity & fill fields, lock buttons, link, fx, mask, adjustment, group, new, delete buttons
- [ ] Layers panel filtering: kind, name, effect, mode, attribute, colour label, smart object, selected, artboard; filter toggle
- [ ] Layer colour labels, Layer properties, panel options
- [ ] Layer auto-rename & layer cleanup suggestions (2026 feature) **(AI)**
- [ ] Layer Comps panel: visibility/position/appearance/smart object comp selection; apply, update, warnings
- [ ] Layer knockouts and Blend If (see B10 Blending Options)

## B7. Adjustments (destructive command + adjustment layer where Photoshop has both)

Each with Properties-panel UI, presets, auto options where applicable, on-image targeted adjustment tool where applicable, clip-to-layer button.

- [ ] Brightness/Contrast (use legacy option)
- [ ] Levels (per channel, input/output, gamma, black/grey/white point eyedroppers, auto options, clipping display with Alt)
- [ ] Curves (point + pencil mode, per channel, presets, eyedroppers, targeted adjustment tool, histogram, show options: intersection, baseline, clipping, channel overlays; light vs pigment display)
- [ ] Exposure (exposure, offset, gamma — esp. 32-bit)
- [ ] Vibrance (vibrance, saturation)
- [ ] Hue/Saturation (master + 6 colour ranges with adjustable sliders, colorize, targeted tool)
- [ ] Color Balance (shadows/midtones/highlights, preserve luminosity)
- [ ] Black & White (6 sliders, tint, auto, targeted tool)
- [ ] Photo Filter (filters list, colour, density, preserve luminosity)
- [ ] Channel Mixer (output channel, monochrome, constant)
- [ ] Color Lookup (3DLUT .cube/.3dl/.look import, abstract, device link; our own bundled looks)
- [ ] Invert
- [ ] Posterize
- [ ] Threshold
- [ ] Gradient Map (dither, reverse, method)
- [ ] Selective Color (relative/absolute)
- [ ] Color & Vibrance adjustment layer (temperature, tint, vibrance, saturation) — 2026
- [ ] Clarity adjustment layer — 2026
- [ ] Grain adjustment layer — 2026
- [ ] Shadows/Highlights (destructive/smart filter; amount, tone, radius, colour, midtones, clipping)
- [ ] HDR Toning (local adaptation, equalize histogram, exposure & gamma, highlight compression; edge glow, tone & detail, curve)
- [ ] Desaturate
- [ ] Match Color (source, layer, luminance, colour intensity, fade, neutralize)
- [ ] Replace Color (localized colour clusters, fuzziness, HSL)
- [ ] Equalize
- [ ] Fill layers: Solid Color, Gradient (with on-canvas controls), Pattern (scale, angle, snap to origin)
- [ ] Adjustments panel with presets and adjustment-preset groups (our own presets)

## B8. Blend modes (exact Photoshop math, all colour modes and bit depths)

- [ ] Normal, Dissolve
- [ ] Darken, Multiply, Color Burn, Linear Burn, Darker Color
- [ ] Lighten, Screen, Color Dodge, Linear Dodge (Add), Lighter Color
- [ ] Overlay, Soft Light, Hard Light, Vivid Light, Linear Light, Pin Light, Hard Mix
- [ ] Difference, Exclusion, Subtract, Divide
- [ ] Hue, Saturation, Color, Luminosity
- [ ] Behind and Clear (painting/fill only)
- [ ] Pass Through (groups)
- [ ] Opacity vs Fill distinction (the "special eight" modes behave differently with Fill)
- [ ] Shift+Plus/Minus to cycle blend modes; Alt+Shift+letter shortcuts for each mode
- [ ] Hover-preview blend modes in the dropdown

## B9. Brush engine & presets

- [ ] Brush Settings panel:
  - [ ] Brush Tip Shape: size, flip X/Y, angle, roundness, hardness, spacing; computed/sampled/bristle/erodible/airbrush tips
  - [ ] Shape Dynamics: size/angle/roundness jitter with controls (off, fade, pen pressure, pen tilt, stylus wheel, rotation, initial direction, direction), minimum diameter, tilt scale, flip jitter, brush projection
  - [ ] Scattering (both axes, count, count jitter)
  - [ ] Texture (pattern, invert, scale, brightness, contrast, texture each tip, mode, depth, jitter)
  - [ ] Dual Brush
  - [ ] Color Dynamics (FG/BG jitter, hue/sat/brightness jitter, purity, apply per tip)
  - [ ] Transfer (opacity/flow/wetness/mix jitter)
  - [ ] Brush Pose (override tilt/rotation/pressure)
  - [ ] Noise, Wet Edges, Build-up, Smoothing, Protect Texture
- [ ] Options bar: size, hardness, mode, opacity, flow, airbrush, smoothing % with options (pulled string mode, stroke catch-up, catch-up on stroke end, adjust for zoom), angle, pressure for size/opacity, symmetry
- [ ] Paint symmetry: vertical, horizontal, dual axis, diagonal, wavy, circle, spiral, parallel lines, radial (segments), mandala (segments); symmetry path editing
- [ ] Brushes panel: groups, search, recent brushes, preview stroke, show additional preset info, Get more → import
- [ ] Import ABR brush files; export our brush format
- [ ] Our own default brush library (general, dry media, wet media, special effects) — created from scratch
- [ ] Brush cursor options (normal/full-size tip, crosshair, show while painting), HUD resize/hardness
- [ ] Native tablet input through Qt tablet events: pressure, tilt, rotation/twist, stylus wheel, eraser end; macOS (Wacom, Sidecar/Apple Pencil), Windows Ink and Wintab, Linux (libinput/XInput2); high-rate sampling for smooth strokes; latency < 1 frame
- [ ] Tool Presets panel (save any tool + options, current tool only filter)
- [ ] Patterns panel, Gradients panel (groups, import GRD/PAT), Swatches panel (import ASE/ACO), Shapes panel (import CSH), Styles panel (import ASL)

## B10. Layer styles & blending options

- [ ] Layer Style dialog with live preview, multiple instances per effect (stroke, inner shadow, color/gradient overlay, drop shadow), default reset/make default, Scale Effects
- [ ] Blending Options: general blend mode/opacity, Fill opacity, channels (R/G/B), knockout (none/shallow/deep), Blend Interior Effects as Group, Blend Clipped Layers as Group, Transparency Shapes Layer, Layer Mask Hides Effects, Vector Mask Hides Effects, Blend If (gray & per channel, this layer/underlying, split sliders)
- [ ] Bevel & Emboss: styles (inner, outer, emboss, pillow, stroke emboss), technique (smooth, chisel hard/soft), depth, direction, size, soften, angle, altitude, global light, gloss contour, highlight/shadow mode & opacity; Contour sub-panel; Texture sub-panel
- [ ] Stroke: size, position, blend, opacity, fill type (colour/gradient/pattern)
- [ ] Inner Shadow, Inner Glow (source centre/edge, choke, technique precise/softer, range, jitter)
- [ ] Satin
- [ ] Color Overlay, Gradient Overlay, Pattern Overlay
- [ ] Outer Glow
- [ ] Drop Shadow (layer knocks out drop shadow, spread, noise, contour)
- [ ] Contour editor and contour presets
- [ ] Global Light
- [ ] Copy/Paste Layer Style, Clear, Create Layer(s) from style, Hide All Effects, Scale Effects
- [ ] Styles panel with our own default style library

## B11. Selections, masks & channels

- [ ] Select menu: All, Deselect, Reselect, Inverse, All Layers, Deselect Layers, Find Layers, Isolate Layers
- [ ] Color Range: sampled colours, colour presets (reds…magentas, highlights, midtones, shadows), skin tones, detect faces, localized colour clusters, fuzziness, range, invert, selection preview modes
- [ ] Focus Area (in-focus range, image noise level, refine edge)
- [ ] Subject, Sky, People (and people features: hair, skin, eyes, clothes, etc.) **(AI)**, device vs cloud processing setting
- [ ] Select and Mask workspace: Quick Selection, Refine Edge Brush, Brush, Object Selection, Lasso, Hand, Zoom; view modes (onion skin, marching ants, overlay, on black, on white, black & white, on layers), show edge/original, high-quality preview; refine mode (colour aware/object aware); edge detection radius & smart radius; global refinements (smooth, feather, contrast, shift edge); Refine Hair; Decontaminate Colors with amount; output to (selection, layer mask, new layer, new layer with mask, new document, new document with mask)
- [ ] Modify: Border, Smooth, Expand, Contract, Feather
- [ ] Grow, Similar
- [ ] Transform Selection (incl. warp)
- [ ] Edit in Quick Mask Mode (options: colour, opacity, masked vs selected areas)
- [ ] Load Selection, Save Selection (new channel, add/subtract/intersect)
- [ ] Ctrl/Cmd-click layer thumbnail → selection from transparency (Shift/Alt/Shift+Alt combine)
- [ ] Marching ants rendering at any zoom; selection edges hide (Ctrl+H)
- [ ] Layer masks, vector masks, clipping masks; Properties panel for masks (density, feather, mask edge, color range, invert)
- [ ] Channels panel: composite + component channels, alpha channels, spot channels (ink colour, solidity), show channels in colour preference, channel thumbnails, load channel as selection, Channel Options, Duplicate/Delete channel, Split Channels, Merge Channels, New Spot Channel, Merge Spot Channel

## B12. Paths, shapes & vectors

- [ ] Paths panel: Work Path, saved paths, shape paths, vector mask paths; fill path, stroke path (with any painting tool, simulate pressure), load as selection, make work path from selection (tolerance), new/delete/duplicate, Clipping Path for export; symmetry paths (edit a paint symmetry's guide as a path, store it in PSD)
- [ ] Path operations: combine, subtract, intersect, exclude, merge shape components
- [ ] Path alignment & arrangement
- [ ] Shape layers with fill & stroke (solid/gradient/pattern, stroke alignment, caps, corners, dashes), live shape properties in Properties panel (W/H/X/Y, angle, per-corner radii, polygon sides/star)
- [ ] Custom shapes library (our own) + CSH import
- [ ] Rubber band, snap to pixel, align edges
- [ ] Copy/paste paths to/from SVG (clipboard)

## B13. Type

- [ ] Point text, paragraph (area) text, type on a path, type inside a closed path
- [ ] Character panel: font family/style (incl. variable fonts with axis sliders), size, leading, kerning (metrics, optical, manual), tracking, vertical/horizontal scale, baseline shift, colour, faux bold/italic, all caps, small caps, superscript, subscript, underline, strikethrough, OpenType features (ligatures, discretionary, swash, contextual alternates, stylistic alternates, titling, ordinals, fractions, stylistic sets), language, anti-aliasing (none, sharp, crisp, strong, smooth, platform)
- [ ] Paragraph panel: align left/centre/right, justify last left/centre/right/all, indents (left, right, first line), space before/after, hyphenation (with settings), Adobe-style single-line and every-line composers (implement our own paragraph composer: greedy and Knuth–Plass), justification settings
- [ ] Character Styles and Paragraph Styles panels (default type styles load/save)
- [ ] Glyphs panel
- [ ] East Asian text options (vertical text, mojikumi, kinsoku, tsume, tate-chu-yoko) and Middle Eastern/Indic (RTL, complex script shaping via HarfBuzz)
- [ ] Warp Text (all 15 styles: arc, arc lower/upper, arch, bulge, shell lower/upper, flag, wave, fish, rise, fisheye, inflate, squeeze, twist; bend, H/V distortion)
- [ ] Type menu: Panels, Anti-Alias, Orientation, OpenType, Create Work Path, Convert to Shape, Rasterize Type Layer, Convert to Point/Paragraph Text, Warp Text, Match Font **(AI)**, Font Preview Size, Language Options, Update All Text Layers, Manage Missing Fonts, Paste Lorem Ipsum, Load/Save Default Type Styles
- [ ] Font sources: system fonts (CoreText / DirectWrite / fontconfig), fonts loaded from files, an optional open-font browser (owner approval)
- [ ] Missing font handling on PSD open (keep text data, substitute for display, warn)
- [ ] Spell check and Find/Replace across text layers
- [ ] Text-engine data round trip in PSD (EngineData parsing/writing)

## B14. Filters

All filters must work destructively and as **smart filters** (with filter mask, blending options, reorder, disable).

- [ ] Convert for Smart Filters
- [ ] Neural Filters workspace **(AI)**: Skin Smoothing, Smart Portrait, Makeup Transfer, Colorize, Super Zoom, JPEG Artifacts Removal, Style Transfer, Harmonization, Landscape Mixer, Depth Blur, Photo Restoration (implement those feasible with open models; log the rest in KNOWN_GAPS)
- [ ] Filter Gallery (stackable, reorderable effect layers in the dialog):
  - [ ] Artistic: Colored Pencil, Cutout, Dry Brush, Film Grain, Fresco, Neon Glow, Paint Daubs, Palette Knife, Plastic Wrap, Poster Edges, Rough Pastels, Smudge Stick, Sponge, Underpainting, Watercolor
  - [ ] Brush Strokes: Accented Edges, Angled Strokes, Crosshatch, Dark Strokes, Ink Outlines, Spatter, Sprayed Strokes, Sumi-e
  - [ ] Distort: Diffuse Glow, Glass, Ocean Ripple
  - [ ] Sketch: Bas Relief, Chalk & Charcoal, Charcoal, Chrome, Conté Crayon, Graphic Pen, Halftone Pattern, Note Paper, Photocopy, Plaster, Reticulation, Stamp, Torn Edges, Water Paper
  - [ ] Stylize: Glowing Edges
  - [ ] Texture: Craquelure, Grain, Mosaic Tiles, Patchwork, Stained Glass, Texturizer
  - [ ] Colour pickers inside Filter Gallery (2026)
- [ ] Adaptive Wide Angle (constraints, fisheye/perspective/full spherical/auto)
- [ ] Camera Raw Filter (see B17)
- [ ] Lens Correction (auto via lens profile database — our own/open lensfun data, custom: geometric distortion, chromatic aberration, vignette, transform)
- [ ] Liquify: Forward Warp, Reconstruct, Smooth, Twirl Clockwise, Pucker, Bloat, Push Left, Freeze Mask, Thaw Mask, Face tool; Face-Aware Liquify **(AI landmarks)** (eyes, nose, mouth, face shape, linked eyes); brush pressure/rate/density; mesh show/save/load; backdrop; pin edges; reconstruct options
- [ ] Vanishing Point (create/edit planes, stamp, brush, transform, measure, render grids)
- [ ] 3D: excluded (removed from Photoshop itself) — log in KNOWN_GAPS
- [ ] Blur: Average, Blur, Blur More, Box Blur, Gaussian Blur, Lens Blur (depth map, iris shape, specular highlights, noise), Motion Blur, Radial Blur (spin/zoom, quality), Shape Blur, Smart Blur, Surface Blur
- [ ] Blur Gallery: Field Blur, Iris Blur, Tilt-Shift, Path Blur, Spin Blur; effects (light bokeh, bokeh colour, light range), motion effects (strobe), noise; save mask to channels; on-canvas pins
- [ ] Distort: Displace (displacement map PSD), Pinch, Polar Coordinates, Ripple, Shear, Spherize, Twirl, Wave, ZigZag
- [ ] Noise: Add Noise (uniform/gaussian, monochromatic), Despeckle, Dust & Scratches, Median, Reduce Noise (basic/advanced per channel, JPEG artifact removal)
- [ ] Pixelate: Color Halftone, Crystallize, Facet, Fragment, Mezzotint, Mosaic, Pointillize
- [ ] Render: Flame, Picture Frame, Tree (our own presets), Clouds, Difference Clouds, Fibers, Lens Flare, Lighting Effects (spot/point/infinite, properties, texture channel, presets)
- [ ] Sharpen: Shake Reduction (blur trace estimation), Sharpen, Sharpen Edges, Sharpen More, Smart Sharpen (gaussian/lens/motion removal, shadows/highlights fade, presets), Unsharp Mask
- [ ] Stylize: Diffuse, Emboss, Extrude, Find Edges, Oil Paint, Solarize, Tiles, Trace Contour, Wind
- [ ] Video: De-Interlace, NTSC Colors
- [ ] Other: Custom (convolution kernel), High Pass, HSB/HSL, Maximum, Minimum, Offset
- [ ] Last Filter (Ctrl/Cmd+Alt+F re-run with dialog), Fade
- [ ] Third-party filter plugins via the OpenFX host and our C++ plugin API (binary 8BF hosting is not planned; see KNOWN_GAPS)

## B15. View menu

- [ ] Proof Setup (Working CMYK/Cyan/Magenta/Yellow/Black/CMY plates, Legacy Mac/Windows RGB, Monitor RGB, colour-blindness protan/deutan, Custom with simulate paper/black ink), Proof Colors, Gamut Warning
- [ ] Pixel Aspect Ratio + Pixel Aspect Ratio Correction
- [ ] 32-bit Preview Options (exposure & gamma, highlight compression), 32-bit exposure slider in status bar (shares the float viewer's controls, B0)
- [ ] Zoom In/Out, Fit on Screen, Fit Artboard, 100%, 200%, Print Size, Actual Size
- [ ] Flip Horizontal (view only)
- [ ] Pattern Preview (seamless tiling preview)
- [ ] Screen Mode
- [ ] Extras toggle; Show: Layer Edges, Selection Edges, Target Path, Grid, Guides, Canvas Guides, Artboard Guides, Artboard Names, Count, Smart Guides, Slices, Notes, Pixel Grid, Mesh, Edit Pins, Brush Preview, Copy/Paste Indicators; All/None
- [ ] Rulers (units, origin drag, right-click unit change)
- [ ] Snap / Snap To: Guides, Grid, Layers, Slices, Document Bounds, All/None
- [ ] Guides: Lock, Clear (canvas/selected artboard/all), New Guide, New Guide Layout (columns, rows, gutter, margins, presets), New Guides from Shape; guide colours
- [ ] Lock Slices, Clear Slices
- [ ] Navigator panel, Bird's-eye view (hold H and click)

## B16. Window panels (each fully functional)

- [ ] Actions, Adjustments, Brush Settings, Brushes, Channels, Character, Character Styles, Clone Source (5 sources, offset, scale, rotate, overlay), Color (sliders: grayscale/RGB/HSB/CMYK/Lab/web; wheel; cube), Comments (local notes; optional collaboration later), Content Credentials, Glyphs, Gradients, Histogram (compact/expanded/all channels, statistics, cache refresh), History (snapshots, non-linear history option, history brush source), Info (two readouts, doc info, sampler readouts, measurement), Layer Comps, Layers, Libraries (local asset library), Measurement Log, Navigator, Notes, Paragraph, Paragraph Styles, Paths, Patterns, Properties (context-sensitive: document, layer, type, shape, smart object, adjustments, masks, quick actions), Shapes, Styles, Swatches, Timeline, Tool Presets, Version History
- [ ] Options bar and Tools visibility toggles
- [ ] Arrange submenu & Workspace submenu
- [ ] Open documents list

## B17. Raw development module (Camera Raw equivalent)

Usable as a raw-file opener and as Filter > Camera Raw Filter on any layer (smart-filter compatible).

- [ ] Decode raw formats via LibRaw (licence check: LGPL-2.1 or CDDL-1.0 — ask the owner), DNG read/write
- [ ] Profiles (our own colour profiles: colour, monochrome, vivid, etc.; import DCP), profile browser
- [ ] Basic/Light: white balance (as shot, auto, presets, eyedropper), temperature, tint, exposure, contrast, highlights, shadows, whites, blacks
- [ ] Presence: texture, clarity, dehaze, vibrance, saturation
- [ ] Curve: parametric, point, per-channel RGB, targeted adjustment
- [ ] Detail: sharpening (amount, radius, detail, masking with Alt preview), noise reduction (luminance + detail/contrast), colour NR (detail, smoothness), AI Denoise **(AI)**, Raw Details, Super Resolution **(AI)**
- [ ] Color Mixer: HSL per 8 colours, Color mode, B&W mix; Point Color
- [ ] Color Grading: shadows/midtones/highlights/global wheels, blending, balance
- [ ] Optics: remove CA, lens profile corrections (lensfun data), distortion, vignetting, defringe (purple/green), lens blur **(AI depth)**
- [ ] Geometry: Upright (auto, level, vertical, full, guided), manual transforms (vertical, horizontal, rotate, aspect, scale, offset), constrain crop
- [ ] Effects: grain (amount, size, roughness), post-crop vignetting (style, midpoint, roundness, feather, highlights)
- [ ] Calibration: shadows tint, R/G/B primary hue & saturation
- [ ] Masking: brush, linear gradient, radial gradient, range (colour, luminance, depth), Subject/Sky/Background/Objects/People **(AI)**, add/subtract/intersect, invert, per-mask full adjustment set
- [ ] Remove/Heal/Clone (incl. generative remove **(AI)**), visualize spots, red eye/pet eye
- [ ] Crop & straighten, Snapshots, Presets (create/import XMP), Before/After views, histogram with clipping warnings, HDR editing & HDR output, filmstrip for multiple files, sync settings, workflow options (colour space, bit depth, size, resolution, sharpen for output, open as smart object)
- [ ] Merge to HDR / Panorama / HDR Panorama (raw)

## B18. Animation & video (Photoshop-style)

These Photoshop features sit on top of our own timeline (B0 Animation): the same clock, keyframes and render queue.

- [ ] Timeline panel: Frame Animation mode — frames, delay, looping, tween (position, opacity, effects), onion skin settings, reverse/copy/paste frames, Make Frames from Layers, Flatten Frames into Layers, Match Layer Across Frames, Unify buttons
- [ ] Timeline panel: Video Timeline mode — video groups, video layers, keyframes (position, opacity, style, layer mask position/enable, vector mask, text warp, transform), transitions (fade, cross fade, fade with black/white/colour, zoom, crush), audio tracks (add, mute, fade in/out), split at playhead, trim, speed, work area, onion skin, frame rate, playback quality
- [ ] Video Layers menu: New Video Layer from File, New Blank Video Layer, Insert/Duplicate/Delete Frame, Replace Footage, Interpret Footage, Show (altered/all), Restore Frame/All Frames, Reload Frame, Rasterize
- [ ] Import Video Frames to Layers (FFmpeg / VideoToolbox decode)
- [ ] Render Video: through the render queue (B0 Output) — ProRes, DNxHR, H.264/H.265, image sequences (EXR/DPX/PNG/TIFF/JPEG), size, frame rate, range, alpha
- [ ] Export animated GIF (via Save for Web/Export As), animated WebP/APNG

## B19. Automation, scripting & extensibility

- [ ] Actions panel: list & button mode, sets, record, stop, play, play from step, step-by-step playback speed, toggle dialogs on/off per step, toggle items, insert menu item, insert stop (with message, allow continue), insert conditional, insert path, record again, duplicate/delete/move steps, playback options (accelerated, step by step, pause for), reset/load/replace/save actions
- [ ] Import Photoshop .ATN action files (map descriptors to our commands; unknown steps reported, not silently dropped)
- [ ] Our own default action sets (frames, text effects, production, image effects, grid presets)
- [ ] Batch: source (folder / file list / opened files / a watched folder), override open, include subfolders, suppress dialogs, destination (folder/save and close), file naming tokens, error log
- [ ] Droplets: saved batch recipes runnable by dropping files onto a launcher, onto the app icon, or from the command line
- [ ] Image Processor (JPEG/PSD/TIFF outputs, resize, run action, copyright, ICC)
- [ ] Scripting API: documented JavaScript API mirroring our command descriptors (document, layers, selection, actions); script runner (File > Scripts > Browse); Script Events Manager (run scripts on events)
- [ ] Plugin host: OpenFX image-effect plugins (as nodes and as smart filters) + our own plugin API with manifest, panels and commands, plugins run out of process where possible; Plugins menu & plugin manager
- [ ] Variables & data sets: text replacement, image replacement, visibility; CSV/TXT import; export data sets as files
- [ ] Image Assets generator (layer naming conventions → assets)

## B20. Colour management & printing

- [ ] Color Settings dialog: presets (our own named presets for general, web, prepress), working spaces (RGB, CMYK, Gray, Spot), colour management policies (preserve embedded, convert to working, off; mismatch/missing prompts), conversion options (engine = lcms, intent: perceptual/relative/saturation/absolute, black point compensation, dither 8-bit), advanced (desaturate monitor colours, blend RGB colours using gamma, blend text colours using gamma), save/load .csf
- [ ] Bundle open ICC profiles (sRGB, Display P3, Rec.2020, ProPhoto-equivalent, AdobeRGB-compatible open equivalent, a default CMYK such as an ISO-coated-compatible open profile, gray gamma 2.2/dot gain) — verify licences
- [ ] Monitor colour: read the display's ICC profile from the OS (ColorSync / Windows colour management / colord), per-monitor when windows move; wide-gamut and EDR/HDR output where available
- [ ] Assign Profile / Convert to Profile (advanced: convert to multichannel profiles)
- [ ] Color Picker dialog: HSB/RGB/Lab/CMYK/hex, only web colours, gamut warnings, add to swatches, Color Libraries (import ASE only)
- [ ] HUD colour picker (hue strip/wheel, sizes)
- [ ] Print dialog: printer selection (native print dialog through Qt Print Support; PDF export), colour handling (printer manages / app manages / separations), printer profile, rendering intent, BPC, proof print, position & size (centre, scale to fit, print selected area), printing marks (corner/centre crop marks, registration marks, description, labels), functions (emulsion down, negative, background, border, bleed), PostScript options → PDF/X output where possible
- [ ] Export PDF (Photoshop PDF equivalent: PDF/X-1a, X-3, X-4 presets, compression, security)

## B21. Preferences

- [ ] General (colour picker, HUD picker, image interpolation, options toggles, auto-show home screen, reset preferences on quit)
- [ ] Interface (colour theme, highlight colour, border styles per screen mode, UI scaling, text size, language, tooltips, rich tooltips, panel options)
- [ ] Workspace (auto-collapse icon panels, open docs as tabs, floating window docking, large tabs, narrow options bar)
- [ ] Tools (show tooltips, gestures, overscroll, animated zoom, zoom with scroll wheel, flick panning, vary round brush hardness, use legacy free transform, show transformation values, double-click layer mask launches Select and Mask, use Shift key for tool switch, snap vector tools to pixel grid)
- [ ] History & Content Credentials (history log to metadata/text file, edit log items)
- [ ] File Handling (image previews, file extension case, save in background, auto-save every N minutes, camera raw preferences, maximise PSD compatibility, recent file list length)
- [ ] Export (quick export format/location/metadata/colour space)
- [ ] Performance (memory usage budget, history states, cache levels & tile size, GPU settings: backend selection Metal/D3D12/Vulkan, GPU choice on multi-GPU machines, RAM frame cache size, node cache size, disk cache location and size)
- [ ] Scratch Disks: choose drives in priority order, usage display, clear disk cache
- [ ] Cursors (painting cursors, other cursors, brush preview colour)
- [ ] Transparency & Gamut (grid size, colours, gamut warning colour/opacity)
- [ ] Units & Rulers (units, column size, new document preset resolutions, point/pica size)
- [ ] Guides, Grid & Slices (colours, styles, gridline every, subdivisions)
- [ ] Plugins (enable plugins, filter gallery show all groups)
- [ ] Type (smart quotes, missing glyph protection, font names in English, text engine options: East Asian / World-Ready)
- [ ] Technology Previews (feature flags)
- [ ] Reset all preferences

## B22. File formats

| Format | Read | Write | Notes |
|---|---|---|---|
| PSD | [ ] | [ ] | Full: layers, groups, masks, vector masks, adjustment & fill layers, smart objects (embedded/linked), smart filters, styles, text (EngineData), artboards, layer comps, guides, slices, channels, paths, ICC, XMP, 8/16/32-bit, all colour modes, RLE & ZIP compression, Maximise Compatibility composite |
| PSB (large document) | [ ] | [ ] | Up to 300,000 px per side (limit by device memory; document it) |
| TIFF | [ ] | [ ] | Layers (Photoshop TIFF layer data), LZW/ZIP/JPEG, 8/16/32-bit, CMYK, alpha, ICC |
| JPEG | [ ] | [ ] | Quality 0–12 scale UI + baseline/optimised/progressive, ICC, EXIF/XMP |
| JPEG 2000 | [ ] | [ ] | |
| PNG | [ ] | [ ] | 8/16-bit, interlace, compression options |
| GIF | [ ] | [ ] | Animated read/write |
| WebP | [ ] | [ ] | Lossy/lossless, animated |
| AVIF | [ ] | [ ] | Incl. HDR |
| JPEG XL | [ ] | [ ] | |
| HEIC/HEIF | [ ] | [ ] | Read priority; write if licence-safe codec available |
| BMP, TGA, PCX, PBM/PGM/PPM, IFF, Pixar, Scitex CT, Photoshop Raw (.raw) | [ ] | [ ] | |
| PDF (Photoshop-style) | [ ] | [ ] | Open (rasterize pages/images, Import PDF dialog), save with layers preserved as private data |
| EPS | [ ] | [ ] | Read via rasterizer (Ghostscript is AGPL — ask owner first), write EPS/DCS |
| SVG | [ ] | [ ] | Place/open as smart object, export shapes/text |
| AI (PDF-compatible) | [ ] | — | Open/place via PDF engine |
| OpenEXR | [ ] | [ ] | See B0: multi-part/multi-layer, all compressions incl. HTJ2K, deep read, half/float, data/display window; 32-bit Photoshop-style documents |
| Radiance HDR, Portable Float Map | [ ] | [ ] | |
| DICOM | [ ] | [ ] | Incl. multi-frame |
| Cineon/DPX | [ ] | [ ] | 10/12/16-bit log/lin, sequences (see B0 Output) |
| Camera RAW (CR2/CR3/NEF/ARW/RAF/ORF/RW2/DNG…) | [ ] | DNG | Via LibRaw |
| MPO | [ ] | — | |
| Video (MOV/MP4/MXF) | [ ] | [ ] | FFmpeg (LGPL) + VideoToolbox; ProRes, DNxHR, H.264/H.265 (see B0 Output) |
| ABR, PAT, GRD, ASL, CSH, ASE, ACO, ACT, ATN, CUBE/3DL, XMP presets | [ ] | [ ] (own formats + ASE/ACO/CUBE) | Import user-owned preset files |

## B23. Retouching, compositing & photography commands

- [ ] Content-aware algorithms in C++ (multithreaded, GPU where it pays): PatchMatch-based fill, healing (Poisson/gradient-domain), structure/colour adaptation
- [ ] Photomerge (panorama) with feature matching (ORB/SIFT-like), layouts auto/perspective/cylindrical/spherical/collage/reposition, blend images together, vignette removal, geometric distortion correction, content-aware fill transparent areas
- [ ] Merge to HDR Pro (ghost removal, 32-bit or tone-mapped 8/16-bit output, presets)
- [ ] Focus stacking via Auto-Blend
- [ ] Crop and Straighten Photos (scanned photo detection)
- [ ] Load Files into Stack + stack modes (statistics)
- [ ] Generative Upscale / Super Zoom **(AI)**, Harmonize **(AI)**, Generate Background **(AI)**, Remove Background quick action **(AI)**
- [ ] Quick actions in Properties panel (Remove Background, Select Subject)

## B24. Collaboration & cloud (Adobe-specific → our alternatives)

- [ ] Cloud documents → local project files + optional owner-configured sync backend (later; ask owner)
- [ ] Libraries panel → local asset library (colours, character styles, graphics, brushes)
- [ ] Comments/review → optional (later)
- [ ] Adobe Stock, Firefly Boards, Adobe Express, Behance, Adobe Fonts: **not replicated** — log in KNOWN_GAPS; offer stock/fonts via open sources (e.g. Google Fonts) only if owner approves

## B25. Non-functional requirements

- [ ] Opens a 100 MP 16-bit image with 20 layers on a 16 GB laptop without crashing
- [ ] Plays a 1080p multi-layer EXR sequence in real time from the RAM cache; 4K real time on a 32 GB Apple Silicon Mac; the UI stays responsive while caching
- [ ] Brush latency < 16 ms per dab batch; no visible lag at 4K canvas, 500 px brush
- [ ] Autosave + crash recovery restores to the last history state
- [ ] Native installers: signed and notarized macOS app (DMG), Windows installer (signed), Linux AppImage/Flatpak; file associations for our project files, .exr, .psd, .png, .jpg, .tif etc.; works fully offline
- [ ] Localisation framework (Qt translation files; English first)
- [ ] Telemetry: none by default
- [ ] Security: plugins sandboxed; no remote calls except configured AI provider and user-initiated actions
- [ ] Documentation: in-app help pages written by us for every tool and command

---

# PART C — PHASE 0 TASK BREAKDOWN (start here, after the owner's approval)

Goal: open a Cycles multi-layer EXR sequence, play it in real time at 1080p from cache with the AgX view, scrub frames,
and view any AOV. Infrastructure items follow D-006 (applicable Definition of Done items only). Order matters: items 1–2
decide the foundations, 3–4 make every later item testable on all three platforms.

- [ ] 1. **Toolchain.** Owner installs, one step at a time with checks: Xcode (Command Line Tools are not enough for
  Metal tools), Homebrew, CMake ≥ 3.28, Ninja, Git, vcpkg (cloned, `VCPKG_ROOT` set), Qt 6.11.3 (official
  binaries via `aqtinstall`; pinned, D-068). Same list for the Windows machine (Visual Studio 2022
  Build Tools) later in the phase. Record exact versions in `README.md`.
  ↳ partial: the Mac is set up (2026-10-12): Xcode 26.6 with Metal tools, Homebrew, CMake 4.4.4, Ninja 1.13.2, vcpkg
  (tool 2026-09-26, ports at e456309), aqtinstall 3.3.0, Qt 6.11.3 in `~/Qt/6.11.3/macos` with Qt Shader Tools,
  LLVM 21.1.8 (`llvm@21`: clang-format, clang-tidy).
  Versions in `README.md`. Missing: the Windows machine, including running the GPU spike's RHI programs there
  (`spikes/gpu`, D3D12 and Vulkan) to confirm D-069.
- [x] 2. **GPU-layer spike** (in `spikes/gpu/`, never linked into the app): the same small test program written twice,
  on **Qt RHI** and on **Dawn**, measuring on Apple Silicon (and on the Windows/NVIDIA machine before deciding):
  - upload and download an 8K RGBA32F image (GB/s), and a 16K × 16K image as tiles;
  - a compute shader reading/writing RGBA32F storage textures: a separable 64-px Gaussian blur and a per-pixel grade
    on a 4K image (ms per pass);
  - float32 texture sampling with linear filtering (supported or not, per GPU);
  - showing a float texture in a Qt window through an **OCIO GPU shader** (AgX view), including the shader-language
    route (OCIO generates GLSL/MSL/HLSL, not WGSL);
  - EDR/HDR output on the Mac (values > 1.0 visible as brighter-than-white);
  - async GPU→CPU readback without stalling the UI; behaviour when the window moves between displays;
  - build cost (time, binary size, how the dependency is pinned in vcpkg/CMake) and licences of everything involved.
  Output: `docs/specs/gpu-spike.md` with numbers, a recommendation and the reasons, in plain language.
  **Stop and wait for the owner's decision**, then log it in `docs/DECISIONS.md` and update CLAUDE.md §2.
  ↳ note: measured on the Mac (2026-10-12), report `docs/specs/gpu-spike.md`, raw output `spikes/gpu/results/`.
  Recommendation: Qt RHI (OCIO shaders work unchanged and fast, HDR/EDR supported, no extra dependency; Dawn needed
  OCIO shader rewriting, was ~600× slower on ACES 2.0 and rejects HDR on macOS; Dawn transfers frames ~4× faster with
  reused buffers — RHI gets a per-backend transfer path later if needed). Runtime shader baking avoids the GPL-3 `qsb`
  tool. The owner chose **Qt RHI** on the Mac results (D-069); the Windows/NVIDIA check moved to item 1.
- [x] 3. **Repository skeleton:** `CMakeLists.txt`, `CMakePresets.json` (macos/windows/linux × debug/release),
  `vcpkg.json` with a pinned baseline, the folder layout of CLAUDE.md §3.1, `Brand.h` with `APP_NAME`, warnings as
  errors, ASan/UBSan in debug, clang-format and clang-tidy configs, the `run`, `format`, `check-licenses` and `package`
  targets (CLAUDE.md §9). A licence check that reads vcpkg's installed copyright files and fails on anything not
  allowed by CLAUDE.md §1.2. `docs/THIRD_PARTY.md` filled from it.
  ↳ note (2026-10-12): verified on the Mac — debug (ASan/UBSan) and release build, the app opens its (empty) window
  with no sanitizer reports, `run`, `format`, `format-check`, `tidy` (clang-tidy 21), `check-licenses` (14 ports),
  `update-third-party`, `package` → a self-contained, ad-hoc-signed .dmg that runs on its own. Tests `layering` and
  `license_policy` (label unit). Decisions D-070, D-071. DoD (D-006): float/OCIO/sequences/documents/selection/
  history/shortcuts/panels/persistence/performance items N/A for build infrastructure; Windows and Linux presets
  are written but first run in CI (item 4).
- [x] 4. **Tests and CI:** GoogleTest wired into CTest with labels (unit, golden, integration); the float golden-image
  harness (EXR in, EXR expected, per-channel absolute/relative tolerance, NaN/Inf checks, ΔE2000 mode for display-
  referred 8/16-bit results, a difference image written on failure, an update command for reviewed changes); GitHub
  Actions on macOS (arm64), Windows and Linux with the vcpkg binary cache. Ticks after the first green run on GitHub
  (needs a remote — owner).
  ↳ note (2026-10-12): `pf_add_gtest()` with labels and test-time discovery (`cmake/PfTesting.cmake`); the golden
  harness (`tests/support/golden/`: EXR in/out on OpenEXR, float mode with the §4 tolerances and NaN/Inf checks,
  ΔE2000 mode, difference image on failure, `update-golden` target; rules in FORMAT_NOTES §18) with 44 unit tests
  (incl. all 34 CIEDE2000 reference pairs) and its own golden self-test (2 cases); integration test `app_startup`
  (hidden `--smoke-test` option, offscreen). Repository https://github.com/Toku112/pixelforge (public, owner's
  choice); first green CI run 2026-10-12 (run 38276014514): macOS 26, Windows 2022 (MSVC) and Ubuntu 24.04 (GCC),
  each debug (sanitizers) + release, 49/49 tests, check-licenses; format-check and tidy on macOS. Decisions D-072
  (incl. the aqtinstall commit needed for Qt 6.11 on Windows). DoD (D-006): float/OCIO/sequence/document/selection/
  history/shortcut/panel/persistence/performance items N/A for test infrastructure.
- [x] 5. **Float image core (`core/image`):** named channel sets, scene-linear float32 planes, data window vs display
  window, ROI maths, tiles (size decided by measurement, logged), copy-on-write, premultiplied alpha conventions,
  conversions to/from half, 8 and 16-bit at the boundary. Unit tests for every conversion (FORMAT_NOTES).
  ↳ note (2026-10-12): `pf_core` library, `src/core/image/` — half-open `Rect` and region maths, `ChannelSet`
  (canonical order), 256² tiles measured in `spikes/tile-size` (edge tiles clipped, constant tiles, copy-on-write
  with an atomic reference count), `Image` (windows, channels, regions, tile access, thread-safe writes to different
  tiles), premultiply/unpremultiply (alpha 0 keeps colour), 8/16-bit/half conversions and interleaved buffer
  import/export with straight or premultiplied alpha. 75 unit tests (every 8-bit, 16-bit and half code round-trips;
  every straight 8-bit pixel round-trips), debug (ASan/UBSan) and release; tidy, format and licence checks clean.
  FORMAT_NOTES §19, D-073. DoD (D-006): OCIO/sequence/document/selection/history/shortcut/panel/persistence items
  N/A for the data type; performance measured in the spike, conversion loops measured with EXR reading (item 9).
- [x] 6. **Engine services (`engine/`):** oneTBB-based scheduler with priorities (viewer > caching > render), cancellation
  tokens, progress reporting to the UI; memory budget (Preferences value, default 60% of RAM) shared by caches; LRU
  eviction; statistics for the status bar.
  ↳ note (2026-10-12): `pf_engine` library, `src/engine/` — jobs on three oneTBB arenas by priority with results,
  progress, a job list for the UI and run-time thread rules (the UI thread and jobs never wait for jobs);
  `parallelFor` keeps a job's priority and stops when cancelled; chainable cancellation tokens; memory budget measured
  as real tile memory, least-recently-used eviction across `LruCache`s; a tile pool (measured in `spikes/tile-alloc`:
  4K grade ~1.2 ms instead of ~1.5–1.9 ms, memory really returned to the system) installed into `core/image` through
  a `std::pmr::memory_resource`; `Engine::stats()` for the status bar (shown from item 13 on); the app creates the
  engine at startup. 62 engine + 2 core unit tests, debug (ASan/UBSan) and release, engine tests repeated 600× under
  load; tidy, format and licence checks clean; CI green on macOS, Windows and Linux. D-074. DoD (D-006): float/OCIO/
  document/selection/history/shortcut/panel/persistence items N/A for engine services; the Preferences > Performance
  control is PLAN Part B (Preferences), the engine takes the value.
- [ ] 7. **Node graph core (`core/graph`, `core/anim`):** nodes, typed ports and parameters, DAG with cycle checks,
  pull evaluation per (frame, ROI, channels, proxy scale), ROI propagation, hashing for cache keys, node result cache,
  keyframe data model with interpolation (constant, linear, smooth, Bézier) and its unit tests. First nodes: Read,
  Viewer, Shuffle (pick channels/AOV), Exposure — real nodes, not test stubs.
- [ ] 8. **Commands and history (`core/commands`, `core/history`):** Command interface with descriptors (JSON) and
  labels; graph edit commands (add/remove/connect/disconnect node, set parameter, set/delete keyframe); slider-drag
  coalescing; undo/redo; History panel model; action recording of descriptors with a replay test.
- [ ] 9. **EXR reading (`io/exr`):** OpenEXR ≥ 3.4.14; scanline and tiled; multi-part and multi-layer channel naming
  (`layer.view.channel`, Cycles `ViewLayer.Pass.Channel`, Redshift/Octane conventions); half/float/uint; every
  compression incl. HTJ2K; data/display window; multi-view; deep parts detected and reported (flattening is Phase 1);
  lazy per-channel decode on background threads; metadata to a key/value model. Golden tests with our own generated
  fixtures for every compression type, plus fuzz-style tests with truncated/corrupt files (no crash, clear error).
- [ ] 10. **Sequences (`io/sequence`):** frame-pattern detection (`name.1001.exr`, `name_1001.exr`, `name1001.exr`,
  `####`, `%04d`, `@@@@`, negative frames, mixed padding), frame range and gaps, missing frames (hold / black /
  checker, listed in the Read node), file-change detection groundwork for live linking. Unit tests on generated
  folders.
- [ ] 11. **OCIO (`color/`):** OpenColorIO 2.x; bundled ACES 2.0 config (the ACES CG/studio configs from the OpenColorIO-Config-ACES project, BSD-3; recent OCIO releases also build them in — verify version and licence) and an AgX config —
  only after its licence is confirmed (THIRD_PARTY; otherwise use the config from the user's own Blender install or
  our own AgX-style config, D-066); load a config file; `$OCIO`; input colour-space detection from EXR metadata
  and the config's file rules; CPU processor for tests and export, GPU shader path for the viewer. Golden tests against
  OCIO's own CPU results.
- [ ] 12. **GPU layer (`gpu/`) and viewer (`ui/viewer`):** our thin `gpu::` interface over the backend chosen in item 2;
  texture pool; tiled uploads; the float viewer: pan/zoom (Photoshop navigation keys), exposure/gamma, display/view
  menus, channel/AOV selector, R/G/B/A/luma, float pixel inspector, HiDPI, EDR where the spike proved it. CPU and GPU
  display paths agree within tolerance.
- [ ] 13. **Native shell (`ui/`):** Qt Widgets main window with Photoshop's menu bar structure (all top-level menus;
  unbuilt items hidden behind a feature flag), the macOS app menu, dock system (panels dock, stack, collapse to icons,
  float; layout saved per workspace — dock framework choice measured and logged), status bar, viewer area, node view
  (basic: create via Tab menu, connect, select, move, view node), Read-node properties, Metadata panel, History panel,
  four interface brightness themes. Keymap system with Photoshop defaults, platform modifiers, contexts and
  spring-loaded keys (CLAUDE.md §7). Open via File > Open and drag-and-drop.
- [ ] 14. **Timeline and RAM playback cache:** timeline bar with play/stop, frame step, scrub, in/out points, frame rate,
  loop; background prefetch of frames ahead of the playhead into the RAM cache (budgeted), a cached-frames bar, dropped-
  frame counter; playback runs at the set fps without blocking the UI.
- [ ] 15. **Fixtures and Phase 0 exit test:** owner provides short renders (Cycles: multi-layer EXR sequence with
  several passes, a light group and Cryptomatte; Redshift and Octane equivalents for Phase 1); we also generate our own
  synthetic sequences. Automated integration test: open the Cycles sequence headless, list all AOVs, evaluate any AOV
  through the AgX view at every frame, measure cached playback at 1080p (must hold the frame rate). Owner check
  (`docs/phase0-check/README.md`): play it on the Mac, scrub, switch AOVs; the Windows build runs the same steps.
- [ ] 16. **Developer packaging:** a double-clickable macOS `.app` (Qt deployed, ad-hoc signed) and a Windows zip build
  for the owner's checks; real signing/notarizing and installers come in Phase 15.
  ↳ note: the Windows zip must also ship vcpkg's DLLs (oneTBB's `tbb12.dll` and `tbbmalloc.dll` since item 6;
  windeployqt copies only Qt's).

---

# PART D — PHASE 1 TASK BREAKDOWN

_Written when Phase 0 ends (CLAUDE.md §4: no phase jumps)._
