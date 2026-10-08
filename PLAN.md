# PLAN.md — Feature inventory and build roadmap

> Reference target: **Photoshop 2026 (desktop v27.x)**, behaviour taken from Adobe's public Photoshop User Guide.
> Read `CLAUDE.md` first. Tick `[x]` only when the Definition of Done in `CLAUDE.md §5` is met.
> Items marked **(AI)** go through the `AIProvider` interface. Items marked **(web-alt)** have no direct browser equivalent and get the documented alternative.

---

## Current status

_Update this section at the end of every session._

- Phase: 2 — Painting engine (task list in Part E). Started on 2026-10-08 at the owner's request, before the owner's
  Phase 1 check with real Photoshop (`docs/phase1-check/README.md`, Part D item 13); fixes from that check come first
  when it arrives.
- Last completed: Phase 1, Part D items 1–12 and the automated part of item 13
- Next up: Part E item 1 (pen input and brush tips)
- Blockers: none. CI needs a GitHub remote to run.

---

# PART A — ROADMAP (build order)

Build in this order. Each phase ends with a working, releasable app. Do not start a phase until the previous phase's exit criteria pass.

| Phase | Goal | Exit criteria |
|---|---|---|
| **0. Foundation** | Repo, tooling, CI, WASM pipeline, tiled document model, command/history system, WebGL compositor with Normal blend, app shell | Open a PNG, view it, pan/zoom smoothly, undo a test command |
| **1. Core editor MVP** | Layers panel, basic selections, Move, Brush/Eraser (simple), Fill, Crop, Image/Canvas Size, Free Transform, all 27 blend modes, opacity/fill, open/save PNG/JPEG/WebP + basic PSD | Edit a layered composition and round-trip a simple PSD with real Photoshop |
| **2. Painting engine** | Full brush engine, Brush Settings panel, pressure/tilt, symmetry, Mixer Brush, Gradient tool & editor, patterns, History Brush | A digital painter can paint a full illustration |
| **3. Selections & masks** | All selection tools, Select and Mask, Color Range, Quick Mask, layer/vector/clipping masks, channels & alpha channels | Complex compositing (hair cut-out) achievable without AI |
| **4. Adjustments** | All adjustments as both destructive commands and adjustment layers, Properties panel, Histogram/Info panels, fill layers | Full photographic colour-grading workflow |
| **5. Vector & type** | Pen tools, paths, shape layers & live shapes, full type engine (point/paragraph/path text, OpenType, styles), warp text | Design a poster with editable text & shapes that round-trips as PSD |
| **6. Layer styles & smart objects** | All 10 effects + blending options, styles panel, smart objects (embedded/linked), smart filters, layer comps, artboards | UI/marketing design workflow, non-destructive |
| **7. Colour management & modes** | lcms2, all modes & bit depths, profiles, soft proofing, own full PSD/PSB codec, TIFF/PDF/EXR etc. | Pre-press CMYK job, 16-bit and 32-bit HDR documents round-trip |
| **8. Filters** | Every filter incl. Filter Gallery, Blur Gallery, Liquify, Lens Correction, Adaptive Wide Angle, Vanishing Point | All filter menu items work, as smart filters too |
| **9. Retouching & transforms** | Healing family, Clone Source, Content-Aware Fill/Scale/Move, Puppet/Perspective Warp, warp, Auto-Align/Blend, Photomerge, HDR | Professional retouching workflow |
| **10. Raw development** | Full Camera-Raw-equivalent module (as dialog and as filter) | Edit a camera RAW end-to-end |
| **11. Automation** | Actions (+ATN import), Batch, Droplets(web-alt), Image Processor, scripting API, plugin host, variables/data sets | Batch-process 500 images via a recorded action |
| **12. Web, animation & video** | Slices, Export As, Save for Web, asset generation, frame animation, video timeline, render video | Export animated GIF and MP4 |
| **13. AI features** | Select Subject/Sky/People, Remove tool, Generative Fill/Expand, Neural-filter equivalents, Denoise, upscale, Sky Replacement | AI features run locally (or via configured provider) on new layers |
| **14. Print, prefs, polish** | Print dialog, all Preferences, workspaces, shortcut editor, menu/toolbar customisation, onboarding, perf hardening | Pro user beta with real-world files |

---

# PART B — COMPLETE FEATURE INVENTORY

## B1. Workspace & interface

- [ ] Menu bar: File, Edit, Image, Layer, Type, Select, Filter, View, Plugins, Window, Help (same order and grouping)
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
  ↳ partial: classic-mode box (draw, move, resize; Shift/Alt), ratio presets with swap/clear, rule-of-thirds while dragging, fixed shield, Delete Cropped Pixels, Enter/Esc and ✓/⊘ (Part D item 10, D-031). Missing: size/resolution presets, straighten and rotating the box, the other overlays, shield settings, content-aware fill, the image-moves (non-classic) mode.
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
- [ ] Open, Open As, Open as Smart Object, Open Recent, Browse (web-alt: file picker + drag-and-drop + recent list)
- [ ] Close, Close All, Close Others, Close and Go to Home
- [ ] Save, Save As, Save a Copy, Revert (File System Access API for save-in-place; download fallback)
  ↳ partial: Save (in place when nothing would be lost) and Save As (name, format, options; download fallback) work (D-033). Missing: Save a Copy, Revert.
- [ ] Version History / autosave & crash recovery (OPFS journal)
- [ ] Export: Quick Export as PNG, Export As (multiple sizes/suffixes, format, quality, metadata, colour space, canvas size, preview), Export Preferences
- [ ] Export: Save for Web (Legacy) dialog — 2-up/4-up, optimisation per format, colour table, image size, preview in browser
- [ ] Export: Artboards to Files, Artboards to PDF, Layer Comps to Files/PDF, Layers to Files, Color Lookup Tables, Data Sets as Files, Paths to vector file (SVG/AI-compatible path export), Render Video
- [ ] Generate > Image Assets (layer-name-based asset generation)
- [ ] Share (web-alt: Web Share API / copy link)
- [ ] Place Embedded, Place Linked, Package (collect linked files)
- [ ] Automate: Batch, PDF Presentation, Create Droplet (web-alt: saved batch recipe / PWA file handler), Crop and Straighten Photos, Contact Sheet, Conditional Mode Change, Fit Image, Lens Correction (batch), Merge to HDR Pro, Photomerge
- [ ] Scripts: Image Processor, Delete All Empty Layers, Flatten All Layer Effects, Flatten All Masks, Load Files into Stack, Load Multiple DICOM Files, Statistics (stack modes), Script Events Manager, Browse (run script file), Export Layers to Files
- [ ] Import: Variable Data Sets, Video Frames to Layers, Notes, images from device camera (web-alt for WIA)
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
  ↳ partial: everything listed works (Part D item 11, D-032). Missing: stepping back through the box's changes with Ctrl/Cmd+Z while it is open, the right-click menu.
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
  ↳ partial: dimensions in all length units, resolution (px/in, px/cm), Constrain Proportions, Resample on/off, Automatic + the five classic methods, Fit To (own presets) (FORMAT_NOTES §6). Missing: Preserve Details and Preserve Details 2.0 (with Reduce Noise), Scale Styles (with layer styles, Phase 6), the result preview.
- [x] Canvas Size: relative, anchor, extension colour
  ↳ note: all length units, the anchor grid, extension colours (foreground/background/white/black/gray/other) on the Background, a warning before cutting off; Ctrl/Cmd+Alt+C (D-031).
- [ ] Image Rotation: 180°, 90° CW/CCW, Arbitrary, Flip Canvas H/V
  ↳ partial: 180°, 90° CW/CCW and both flips work. Missing: Arbitrary (with Free Transform's resampling, Part D item 11).
- [ ] Crop (to selection), Trim (transparent/top-left/bottom-right colour, per-side), Reveal All
  ↳ partial: Image > Crop to the selection's exact bounds works. Missing: Trim, Reveal All.
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
- [ ] Pointer Events with pressure, tilt, twist; Windows Ink / Apple Pencil (iPad Safari) support; coalesced events for smooth strokes; predicted events for latency
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

- [ ] Paths panel: Work Path, saved paths, shape paths, vector mask paths; fill path, stroke path (with any painting tool, simulate pressure), load as selection, make work path from selection (tolerance), new/delete/duplicate, Clipping Path for export
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
- [ ] Font sources: Local Font Access API (system fonts), uploaded fonts, Google Fonts browser (web-alt for cloud fonts)
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
- [ ] Third-party filter plugins via our plugin API (no binary 8BF support — web-alt; log in KNOWN_GAPS)

## B15. View menu

- [ ] Proof Setup (Working CMYK/Cyan/Magenta/Yellow/Black/CMY plates, Legacy Mac/Windows RGB, Monitor RGB, colour-blindness protan/deutan, Custom with simulate paper/black ink), Proof Colors, Gamut Warning
- [ ] Pixel Aspect Ratio + Pixel Aspect Ratio Correction
- [ ] 32-bit Preview Options (exposure & gamma, highlight compression), 32-bit exposure slider in status bar
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

- [ ] Actions, Adjustments, Brush Settings, Brushes, Channels, Character, Character Styles, Clone Source (5 sources, offset, scale, rotate, overlay), Color (sliders: grayscale/RGB/HSB/CMYK/Lab/web; wheel; cube), Comments (web-alt: local notes or optional collab), Content Credentials, Glyphs, Gradients, Histogram (compact/expanded/all channels, statistics, cache refresh), History (snapshots, non-linear history option, history brush source), Info (two readouts, doc info, sampler readouts, measurement), Layer Comps, Layers, Libraries (web-alt: local asset library), Measurement Log, Navigator, Notes, Paragraph, Paragraph Styles, Paths, Patterns, Properties (context-sensitive: document, layer, type, shape, smart object, adjustments, masks, quick actions), Shapes, Styles, Swatches, Timeline, Tool Presets, Version History
- [ ] Options bar and Tools visibility toggles
- [ ] Arrange submenu & Workspace submenu
- [ ] Open documents list

## B17. Raw development module (Camera Raw equivalent)

Usable as a raw-file opener and as Filter > Camera Raw Filter on any layer (smart-filter compatible).

- [ ] Decode raw formats via LibRaw (WASM), DNG read/write
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

## B18. Animation & video

- [ ] Timeline panel: Frame Animation mode — frames, delay, looping, tween (position, opacity, effects), onion skin settings, reverse/copy/paste frames, Make Frames from Layers, Flatten Frames into Layers, Match Layer Across Frames, Unify buttons
- [ ] Timeline panel: Video Timeline mode — video groups, video layers, keyframes (position, opacity, style, layer mask position/enable, vector mask, text warp, transform), transitions (fade, cross fade, fade with black/white/colour, zoom, crush), audio tracks (add, mute, fade in/out), split at playhead, trim, speed, work area, onion skin, frame rate, playback quality
- [ ] Video Layers menu: New Video Layer from File, New Blank Video Layer, Insert/Duplicate/Delete Frame, Replace Footage, Interpret Footage, Show (altered/all), Restore Frame/All Frames, Reload Frame, Rasterize
- [ ] Import Video Frames to Layers (WebCodecs decode)
- [ ] Render Video: MP4 (H.264/HEVC where supported), WebM, image sequence (PNG/JPEG/TIFF/OpenEXR), size, frame rate, range, alpha
- [ ] Export animated GIF (via Save for Web/Export As), animated WebP/APNG

## B19. Automation, scripting & extensibility

- [ ] Actions panel: list & button mode, sets, record, stop, play, play from step, step-by-step playback speed, toggle dialogs on/off per step, toggle items, insert menu item, insert stop (with message, allow continue), insert conditional, insert path, record again, duplicate/delete/move steps, playback options (accelerated, step by step, pause for), reset/load/replace/save actions
- [ ] Import Photoshop .ATN action files (map descriptors to our commands; unknown steps reported, not silently dropped)
- [ ] Our own default action sets (frames, text effects, production, image effects, grid presets)
- [ ] Batch: source (folder via File System Access / file list / opened files), override open, include subfolders, suppress dialogs, destination (folder/save and close), file naming tokens, error log
- [ ] Droplets (web-alt): saved batch recipes runnable via drag-drop onto the app or PWA File Handling API
- [ ] Image Processor (JPEG/PSD/TIFF outputs, resize, run action, copyright, ICC)
- [ ] Scripting API: documented JavaScript API mirroring our command descriptors (document, layers, selection, actions); script runner (File > Scripts > Browse); Script Events Manager (run scripts on events)
- [ ] Plugin host: sandboxed iframe/Worker plugins with manifest, permissions, panels, commands; Plugins menu & plugin manager (web-alt for UXP)
- [ ] Variables & data sets: text replacement, image replacement, visibility; CSV/TXT import; export data sets as files
- [ ] Image Assets generator (layer naming conventions → assets)

## B20. Colour management & printing

- [ ] Color Settings dialog: presets (our own named presets for general, web, prepress), working spaces (RGB, CMYK, Gray, Spot), colour management policies (preserve embedded, convert to working, off; mismatch/missing prompts), conversion options (engine = lcms, intent: perceptual/relative/saturation/absolute, black point compensation, dither 8-bit), advanced (desaturate monitor colours, blend RGB colours using gamma, blend text colours using gamma), save/load .csf
- [ ] Bundle open ICC profiles (sRGB, Display P3, Rec.2020, ProPhoto-equivalent, AdobeRGB-compatible open equivalent, a default CMYK such as an ISO-coated-compatible open profile, gray gamma 2.2/dot gain) — verify licences
- [ ] Monitor colour: use CSS color-gamut / display-p3 canvas where supported; document limitations in KNOWN_GAPS
- [ ] Assign Profile / Convert to Profile (advanced: convert to multichannel profiles)
- [ ] Color Picker dialog: HSB/RGB/Lab/CMYK/hex, only web colours, gamut warnings, add to swatches, Color Libraries (import ASE only)
- [ ] HUD colour picker (hue strip/wheel, sizes)
- [ ] Print dialog: printer selection (web-alt: browser print + high-res PDF export), colour handling (printer manages / app manages / separations), printer profile, rendering intent, BPC, proof print, position & size (centre, scale to fit, print selected area), printing marks (corner/centre crop marks, registration marks, description, labels), functions (emulsion down, negative, background, border, bleed), PostScript options → PDF/X output where possible
- [ ] Export PDF (Photoshop PDF equivalent: PDF/X-1a, X-3, X-4 presets, compression, security)

## B21. Preferences

- [ ] General (colour picker, HUD picker, image interpolation, options toggles, auto-show home screen, reset preferences on quit)
- [ ] Interface (colour theme, highlight colour, border styles per screen mode, UI scaling, text size, language, tooltips, rich tooltips, panel options)
- [ ] Workspace (auto-collapse icon panels, open docs as tabs, floating window docking, large tabs, narrow options bar)
- [ ] Tools (show tooltips, gestures, overscroll, animated zoom, zoom with scroll wheel, flick panning, vary round brush hardness, use legacy free transform, show transformation values, double-click layer mask launches Select and Mask, use Shift key for tool switch, snap vector tools to pixel grid)
- [ ] History & Content Credentials (history log to metadata/text file, edit log items)
- [ ] File Handling (image previews, file extension case, save in background, auto-save every N minutes, camera raw preferences, maximise PSD compatibility, recent file list length)
- [ ] Export (quick export format/location/metadata/colour space)
- [ ] Performance (memory usage budget, history states, cache levels & tile size, GPU settings with WebGL/WebGPU selection, legacy compositing off)
- [ ] Scratch Disks (web-alt: OPFS quota usage display, clear cache)
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
| EPS | [ ] | [ ] | Read via rasterizer (Ghostscript WASM is AGPL — ask owner first), write EPS/DCS |
| SVG | [ ] | [ ] | Place/open as smart object, export shapes/text |
| AI (PDF-compatible) | [ ] | — | Open/place via PDF engine |
| OpenEXR | [ ] | [ ] | 32-bit, multi-layer |
| Radiance HDR, Portable Float Map | [ ] | [ ] | |
| DICOM | [ ] | [ ] | Incl. multi-frame |
| Cineon/DPX | [ ] | [ ] | |
| Camera RAW (CR2/CR3/NEF/ARW/RAF/ORF/RW2/DNG…) | [ ] | DNG | Via LibRaw |
| MPO | [ ] | — | |
| Video (MP4/MOV/WebM) | [ ] | [ ] | Via WebCodecs |
| ABR, PAT, GRD, ASL, CSH, ASE, ACO, ACT, ATN, CUBE/3DL, XMP presets | [ ] | [ ] (own formats + ASE/ACO/CUBE) | Import user-owned preset files |

Progress notes (Phase 1):

- PSD ↳ partial: open 8/16/32-bit RGB/Grayscale with layers, groups, properties, locks and the Background (masks, clipping, styles, text/smart-object editability and adjustment layers simplified, D-033); save 8-bit RGB with layers. Missing: everything else listed in the row (our own codec, Phase 7).
- JPEG ↳ partial: read (RGB/Gray, ICC, JFIF resolution, EXIF orientation) and write (quality 0–12, baseline/optimised/progressive, matte, ICC, resolution) work; missing: CMYK, EXIF/XMP metadata, the canvas preview of compression.
- PNG ↳ partial: read (all PNG types, 8/16-bit, ICC, resolution) and write (8/16-bit, alpha when needed, ICC, resolution, compression level) work; missing: interlaced writing, a PNG options dialog.
- WebP ↳ partial: read (lossy/lossless, alpha, ICC) and write (lossless everywhere; lossy where the browser encodes it — not Safari; ICC) work; missing: animated, metadata.

## B23. Retouching, compositing & photography commands

- [ ] Content-aware algorithms in WASM: PatchMatch-based fill, healing (Poisson/gradient-domain), structure/colour adaptation
- [ ] Photomerge (panorama) with feature matching (ORB/SIFT-like), layouts auto/perspective/cylindrical/spherical/collage/reposition, blend images together, vignette removal, geometric distortion correction, content-aware fill transparent areas
- [ ] Merge to HDR Pro (ghost removal, 32-bit or tone-mapped 8/16-bit output, presets)
- [ ] Focus stacking via Auto-Blend
- [ ] Crop and Straighten Photos (scanned photo detection)
- [ ] Load Files into Stack + stack modes (statistics)
- [ ] Generative Upscale / Super Zoom **(AI)**, Harmonize **(AI)**, Generate Background **(AI)**, Remove Background quick action **(AI)**
- [ ] Quick actions in Properties panel (Remove Background, Select Subject)

## B24. Collaboration & cloud (Adobe-specific → our alternatives)

- [ ] Cloud documents → local projects in OPFS + optional owner-configured sync backend (later; ask owner)
- [ ] Libraries panel → local asset library (colours, character styles, graphics, brushes)
- [ ] Comments/review → optional (later)
- [ ] Adobe Stock, Firefly Boards, Adobe Express, Behance, Adobe Fonts: **not replicated** — log in KNOWN_GAPS; offer stock/fonts via open sources (e.g. Google Fonts) only if owner approves

## B25. Non-functional requirements

- [ ] Opens a 100 MP 16-bit image with 20 layers on a 16 GB laptop without crashing
- [ ] Brush latency < 16 ms per dab batch; no visible lag at 4K canvas, 500 px brush
- [ ] Autosave + crash recovery restores to the last history state
- [ ] Offline-capable PWA (installable; file handlers for .psd/.png/.jpg etc.)
- [ ] Localisation framework (all UI strings in i18n files; English first)
- [ ] Telemetry: none by default
- [ ] Security: plugins sandboxed; no remote calls except configured AI provider and user-initiated actions
- [ ] Documentation: in-app help pages written by us for every tool and command

---

# PART C — PHASE 0 TASK BREAKDOWN (start here)

- [x] Initialise repo: pnpm, Vite, React, TypeScript strict, ESLint, Prettier, Vitest, Playwright, Husky pre-commit
- [x] Rust workspace under `src/wasm/` with one sample crate built by `wasm-pack`, SIMD + threads (COOP/COEP headers in dev server and production config)
- [ ] CI (GitHub Actions): typecheck, lint, unit, golden, e2e, wasm build
  ↳ partial: `.github/workflows/ci.yml` written and every step verified locally with `CI=true`; it has not run on GitHub yet because the repo has no remote. Tick after the first green run on GitHub.
- [x] `core/document`: Document, LayerNode tree, PixelLayer with tiled buffer (8/16/32-bit), Background layer semantics
- [x] `core/commands` + `core/history`: Command interface, descriptors, undo/redo stack with tile-diff storage, history labels
- [x] `engine/tiles`: tile store, dirty-rect tracking, memory budget, OPFS eviction
  ↳ note: eviction covers tiles not used by open documents (undo data, snapshots); swapping live tiles of documents larger than RAM is part of B25 (see KNOWN_GAPS, DECISIONS D-015).
- [x] `engine/gl`: WebGL2 context, tile textures, compositor with Normal blend + opacity, transparency checkerboard, mip pyramid
- [x] Viewport: pan, zoom (0.1%–12800%), rotate view, pixel grid at high zoom, HiDPI
  ↳ note: Hand/Zoom/Rotate View tools, wheel/pinch, Space/Ctrl+Space spring-loading and pan limits work on the canvas; toolbar buttons, options-bar fields and View-menu shortcuts are wired in the app-shell and keymap tasks.
- [x] App shell: menu bar (all top-level menus present; unimplemented items hidden behind feature flags), toolbar frame, options bar frame, docking panel framework, status bar, document tabs
  ↳ note: Phase 0 panels are History and Navigator; workspace saving beyond the Essentials layout, toolbar double-column mode, screen modes and the Home screen are PLAN B1 items.
- [x] `io`: format registry; PNG/JPEG/WebP open via WASM codecs; drag-and-drop open; Save As PNG
  ↳ note: wired into the app's File menu and canvas in the app-shell task; known temporary limits (palette → RGB, CMYK JPEG, PNG-only save) in KNOWN_GAPS.
- [x] Keymap system with Photoshop-default bindings scaffold and conflict handling
  ↳ note: connected to menus and tools in the app-shell task; the Keyboard Shortcuts editor UI is PLAN B4.
- [x] Golden-image test harness with ΔE2000 comparison and diff image output
- [x] `docs/` files created: THIRD_PARTY.md, DECISIONS.md, FORMAT_NOTES.md, KNOWN_GAPS.md

---

# PART D — PHASE 1 TASK BREAKDOWN

Goal: edit a layered composition and round-trip a simple PSD with real Photoshop. Each item ticks only when its
Definition of Done (CLAUDE.md §5) holds for the scope stated; the matching Part B items stay unticked until their full
scope (all modes, masks, etc.) is complete.

- [x] Layer model and commands: multi-layer selection; New/Delete/Duplicate/Rename layer; New Group, Group/Ungroup; reorder and Arrange (bring forward/to front, send backward/to back); visibility, locks, opacity, fill, blend mode; Layer from Background
  ↳ note: Background from Layer moved to the merge/flatten item (it needs the same compositing step); the New Layer / Duplicate Layer dialogs come with the Layers panel.
- [x] Layers panel: thumbnails, visibility (Alt-click solo), rename, blend mode menu, Opacity/Fill fields, lock buttons, new/delete/group buttons, drag to reorder, multi-select, group expand/collapse
  ↳ note: includes the New Layer, New Group, Group from Layers, Layer from Background and Duplicate Layer dialogs and keyboard navigation (D-024). Not in this item (Part B Layers panel): filtering by kind, colour labels, Panel Options (thumbnail size/contents), Alt-drag to duplicate, dragging across eyes, row context menu, mask/fx/adjustment buttons (their phases).
- [x] All 27 blend modes with Photoshop math in the CPU and GPU compositors (incl. Dissolve, Darker/Lighter Color, Hue/Saturation/Color/Luminosity, Fill vs Opacity for the "special eight"); Shift+/− and Alt+Shift+letter blend-mode shortcuts
  ↳ note: formulas in FORMAT_NOTES §3, choices in D-023. The blend-mode menu itself comes with the Layers panel; PSD blend-mode keys with the PSD item; CMYK on screen with Phase 7. The Special-eight Fill formula should be re-checked against real reference files when the owner provides them.
- [x] Merge Down, Merge Visible, Stamp Visible, Flatten Image, Background from Layer (composited off the main thread)
  ↳ note: also Merge Layers and Merge Group (Ctrl/Cmd+E adapts, as does its menu label); progress bar and Esc-to-cancel for long commands added here (D-025). Compositing is TypeScript in the pixel worker (~0.6 s per 6000×4000 16-bit layer); a Rust/multi-threaded compositor is a later performance task.
- [x] Selections: selection mask model; Select All/Deselect/Reselect/Inverse; Rectangular, Elliptical, Single Row/Column Marquee; Lasso and Polygonal Lasso (new/add/subtract/intersect, feather, anti-alias); marching ants; selection-aware Invert and Delete
  ↳ note: also marquee styles (Fixed Ratio/Size), Shift/Alt/Space while dragging, moving the outline, M/L and Shift+M/L tool keys (D-026, FORMAT_NOTES §4).
- [x] Foreground/background colours in the toolbar (X swap, D default) and a Color Picker dialog
  ↳ note: picker with HSB/RGB/Lab/hex fields, saturation–brightness field and hue strip (D-027); Clear and Background from Layer use the background colour. Not in this item (Part B picker): field modes other than hue, Only Web Colors, gamut warning, Add to Swatches, Color Libraries, CMYK fields (colour management, Phase 7).
- [x] Brush and Eraser (simple round brush: size, hardness, opacity, flow, spacing, pen pressure; [ ] { } and number-key shortcuts), painting off the main thread with tile-diff undo
  ↳ note: Opacity caps a stroke, Flow builds up; Shift-click lines; selection and locked transparency respected; strokes recorded as replayable descriptors (D-028). Not in this item (Phase 2 painting engine): brush blend modes (the blend-mode shortcuts must then set the tool's mode while a painting tool is active; until then they do nothing with the Brush/Eraser), Brush Settings panel and presets, tilt/rotation, smoothing, Alt+right-drag size HUD, Pencil.
- [x] Edit > Fill (foreground/background/colour/black/white/50% gray, mode, opacity, preserve transparency) and Delete/Backspace fills
  ↳ note: Fill dialog (Color… opens the Color Picker over it), Alt/Ctrl+Backspace quick fills (Shift: preserve transparency), Delete on the Background opens Fill (D-029). Content-Aware, Pattern and History contents come with their features (PatchMatch, patterns, History Brush).
- [x] Move tool: move layers (and selected pixels), auto-select, arrow nudge (Shift = 10 px), Alt-drag duplicate
  ↳ note: also Shift-constrained drags, live preview, arrows moving the selection outline with selection tools (D-030). Not in this item (Part B): transform controls, align/distribute buttons, moving between documents.
- [x] Crop tool and Image > Crop; Image Size (resample methods); Canvas Size (anchor, relative); Image Rotation (180°, 90° CW/CCW, Flip Canvas)
  ↳ note: one snapshot-based command per change, pixel work in the worker with progress, 8/16/32-bit (D-031, FORMAT_NOTES §6); the view re-centres after a size change. Part B items above list what the full features still need (Crop tool straighten/overlays, Preserve Details, Arbitrary rotation, Trim, Reveal All).
- [x] Free Transform (Ctrl/Cmd+T): scale, rotate, skew, distort, perspective, numeric fields, reference point, interpolation
  ↳ note: layers (GPU live preview) and selected pixels (the selection moves too), proportional by default, 8/16/32-bit (D-032, FORMAT_NOTES §6.1). Ctrl/Cmd+T is browser-reserved in a normal tab (KNOWN_GAPS); the Edit menu works everywhere. Undo inside an open box, Warp and Transform Again are Part B.
- [x] Save As JPEG and WebP with options; basic PSD open/save (layers, groups, names, visibility, opacity, fill, blend modes; 8-bit RGB) via ag-psd
  ↳ note: Save As dialog with formats, JPEG Options (our own encoder: quality 0–12, baseline/optimised/progressive, matte, ICC, resolution), WebP Options (lossless ours; lossy via the browser's encoder, not in Safari), PSD open (8/16/32-bit RGB/Gray, groups, locks, Background; simplified features listed) and save (8-bit RGB) (D-033, D-034, FORMAT_NOTES §7).
- [ ] Phase 1 exit test: edit a layered composition and round-trip it as PSD (automated), plus owner check with real Photoshop
  ↳ partial: the automated round trip passes in Chromium, Firefox and WebKit (`tests/e2e/phase1-exit.spec.ts`: canvas size, brush stroke, move, Multiply square with opacity/fill and a lock, feathered ellipse turned with Free Transform inside a Screen group, a hidden layer — same layers and same image after saving and reopening, and again after a second save). Waiting for the owner's check with real Photoshop (`docs/phase1-check/README.md`).

---

# PART E — PHASE 2 TASK BREAKDOWN

Goal: a digital painter can paint a full illustration. Each item ticks only when its Definition of Done (CLAUDE.md §5)
holds for the scope stated; the matching Part B items stay unticked until their full scope is complete. Order: the
engine first, then its controls, then the tools built on it.

- [ ] Pen input and brush tips: Pointer Events pressure, tilt (tiltX/Y, altitude/azimuth), twist and stylus wheel, coalesced and predicted events; computed tips with angle, roundness, flip X/Y; sampled tips from images (Define Brush Preset); brush paint modes (the tool's blend mode in the options bar, and the blend-mode shortcuts setting it while a painting tool is active)
- [ ] Brush dynamics: Shape Dynamics (size/angle/roundness jitter, minimum diameter, tilt scale, flip jitter), Scattering, Transfer (opacity/flow jitter), Color Dynamics (FG/BG, hue/saturation/brightness, purity, per tip), Brush Pose; controls off/fade/pen pressure/pen tilt/stylus wheel/rotation/initial direction/direction; seeded jitter so recorded strokes replay identically
- [ ] Texture, Dual Brush, Noise, Wet Edges, Build-up (airbrush, paint while held still), Protect Texture
- [ ] Brush Settings panel and the full Brush options bar (size, hardness, mode, opacity and flow with pressure toggles, airbrush, smoothing, angle, symmetry), on-canvas size/hardness HUD (Alt+right-drag / Ctrl+Option-drag), brush cursor preferences
- [ ] Stroke smoothing: pulled-string mode, stroke catch-up, catch-up on stroke end, adjust for zoom
- [ ] Paint symmetry: vertical, horizontal, dual axis, diagonal, wavy, circle, spiral, parallel lines, radial and mandala (segments), with an editable symmetry path
- [ ] Brushes panel and presets: groups, search, recent brushes, preview stroke; our own default brush library (general, dry media, wet media, special effects); our brush preset file; ABR import; Tool Presets panel
- [ ] Brush engine speed: dab rendering in WebAssembly (SIMD) so a 500 px soft brush paints at 60 fps on a 6000 × 4000 16-bit document
- [ ] Eyedropper tool (I) and Alt-click sampling with painting tools (sample size, current/all layers, sampling ring); Color panel (sliders, ramp) and Swatches panel (add/delete, ASE/ACO import)
- [ ] Pencil tool (aliased, Auto Erase) and Eraser modes (Brush/Pencil/Block)
- [ ] Gradient tool (G), classic mode: linear, radial, angle, reflected, diamond; reverse, dither, transparency; methods perceptual/linear/classic/smooth/stripes; Gradient Editor (colour and opacity stops, midpoints, smoothness, noise gradients); Gradients panel; GRD import
- [ ] Patterns: Edit > Define Pattern, Patterns panel, PAT import, Pattern contents in Edit > Fill, Pattern Stamp tool
- [ ] Paint Bucket: foreground or pattern, tolerance, contiguous, anti-alias, all layers, mode and opacity
- [ ] History Brush (Y), Art History Brush, the History panel's source column, Eraser's Erase to History, History contents in Edit > Fill
- [ ] Mixer Brush: wet, load, mix, flow, load/clean after each stroke, sample all layers, presets
- [ ] Brush-based retouching that painters rely on: Smudge (finger painting), Blur and Sharpen (protect detail), Dodge, Burn and Sponge
- [ ] Phase 2 exit test: a scripted painting session (pressure strokes, dynamics, symmetry, gradient, pattern, history brush, mixer brush) round-trips through PSD, plus the owner painting a small illustration with a tablet
