# Format and maths notes

Pixel formats, colour maths, blend-mode formulas and file-format details, written in our own words.
Every blend mode and adjustment formula must be documented here (CLAUDE.md §3.3).

---

## 1. Internal pixel storage

| Bit depth | Storage type | Range                        | Notes                                                 |
| --------- | ------------ | ---------------------------- | ----------------------------------------------------- |
| 8-bit     | `Uint8`      | 0–255                        |                                                       |
| 16-bit    | `Uint16`     | 0–65535                      | Full range internally; converted on PSD I/O (see 1.1) |
| 32-bit    | `Float32`    | linear light, may exceed 1.0 | HDR; 0.0 = black, 1.0 = diffuse white                 |

### 1.1 16-bit range conversion

The reference app's 16-bit mode uses the range 0–32768 (so that 50% grey is exactly 16384). We store 0–65535.

- Reading a 16-bit PSD value `v` (0–32768): `internal = round(v * 65535 / 32768)`.
- Writing an internal value `x` (0–65535): `v = round(x * 32768 / 65535)`.

Both mappings are monotonic and keep 0 and full scale exact.

### 1.2 Channel layout and encodings

- Samples are interleaved per pixel: colour channels in mode order, then alpha (if the buffer has transparency).
  Alpha is straight (not premultiplied). Background layers have no alpha channel.
- **RGB / Grayscale / Duotone / Bitmap:** 0 = black, max = white. Bitmap documents are stored as 8-bit 0/255.
- **CMYK:** samples are **ink amounts**, 0 = no ink, max = 100 % ink (PSD stores the inverse; converted on I/O).
- **Lab:** L\* scaled 0–100 → 0–max; a\* and b\* offset so that 0 maps to mid-scale (128 in 8-bit, 32768 in 16-bit).
  32-bit Lab is not supported (as in the reference app).
- **Indexed:** one channel of palette indices plus the colour table.

### 1.3 Tiles

Layer pixels live in 256 × 256 tiles (`src/core/document/tile.ts`). Tiles are allocated on first write; an unallocated
tile reads as the buffer's default pixel (transparent, or the background colour for a Background layer). Tiles are
copy-on-write: a tile captured for undo or shared with another buffer is frozen and replaced by a private copy before
the next write, so undo data is only the tiles that changed.

### 1.4 Layer order and position

Group children are stored bottom → top (index 0 = bottom), as in PSD files. Each pixel layer has an integer offset
(`offsetX/offsetY`) applied to its tile grid, so moving a layer by whole pixels does not rewrite its tiles; layers may
hold pixels outside the canvas.

## 2. Colour measurement

### 2.1 sRGB transfer function

Encoded value `v` (0–1) to linear light: `v / 12.92` when `v ≤ 0.04045`, otherwise `((v + 0.055) / 1.055)^2.4`.
The inverse uses the threshold `0.0031308`. Values outside 0–1 (HDR) are mirrored around zero so the curve stays
monotonic.

### 2.2 L\*a\*b\* (D50)

Linear sRGB → XYZ uses the sRGB primaries adapted from D65 to D50 with the Bradford transform:

```
X = 0.436074716 R + 0.385064915 G + 0.143080403 B
Y = 0.222504478 R + 0.716878669 G + 0.060616852 B
Z = 0.013932173 R + 0.097104526 G + 0.714173298 B
```

Reference white is the matrix row sums (X 0.96422, Y 1, Z 0.82521), so sRGB white is exactly neutral. Then the
standard CIE formulas: `L = 116 f(Y/Yn) − 16`, `a = 500 (f(X/Xn) − f(Y/Yn))`, `b = 200 (f(Y/Yn) − f(Z/Zn))`, with
`f(t) = ∛t` above `(6/29)³` and the linear segment `(t·(29/3)³ + 16) / 116` below it.

### 2.3 ΔE00 (CIEDE2000)

Implemented per Sharma, Wu & Dalal (2005); verified against all 34 of their published test pairs to 4 decimals.

### 2.4 Golden-image comparison

Both images are composited in linear light over black and over white; each pixel's difference is the larger ΔE00 of
the two. Colour under zero alpha is therefore ignored, while alpha differences are caught. Pass criteria (CLAUDE.md
§4): average ΔE00 ≤ 1.0 and maximum ≤ 3.0 unless a test documents otherwise. For scale, raising one 8-bit channel by
one code value gives a worst case around 0.6.

## 3. Compositing and blend modes

Compositing works in the document's own encoding: gamma-encoded values (0–1) for 8/16-bit documents, linear light for
32-bit (the reference app's default; "blend RGB colours using gamma" is a later option). Layers have straight alpha;
the compositor works premultiplied internally.

### 3.1 Normal

With layer alpha `α`, layer opacity `o` and fill opacity `f`: `a = α·o·f`; premultiplied colour
`C' = C·a + C_b·(1 − a)`; alpha `A' = a + A_b·(1 − a)`. A Background layer is opaque everywhere.

### 3.2 Blend modes: the general formula

`b` is the backdrop colour (straight, from the composite so far, alpha `A_b`), `s` the layer colour (straight), both
0–1 per channel. `B(b, s)` is the mode's blend function (§3.3, §3.4). Where the backdrop is transparent the layer shows
as in Normal; where it is opaque the result is `B`; in between the two are weighted by the backdrop alpha:

- `a_B = α·o` (times `f` too, except for the "special eight" — §3.5) — strength of the blended part
- `a_T = a_B` (times `f` for the special eight) — how much the layer adds to the coverage
- premultiplied colour `C' = a_T·(1 − A_b)·s + a_B·A_b·B(b, s) + (1 − a_B)·C_b`
- alpha `A' = A_b + (1 − A_b)·a_T`

With `B(b, s) = s` this reduces exactly to Normal. Code: `blendInto` in `core/composite/flatten.ts` (CPU) and
`compositeOver` in `engine/gl/shaders.ts` (GPU).

**CMYK** documents store ink amounts; the modes are defined on additive values, so `b`, `s` and the result are
inverted (`1 − v`) around `B`. (Multiply therefore darkens a CMYK image the same way it darkens RGB.)

### 3.3 Separable modes (per channel)

| Mode               | `B(b, s)`                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Normal, Dissolve   | `s`                                                                                         |
| Darken / Lighten   | `min(b, s)` / `max(b, s)`                                                                   |
| Multiply           | `b·s`                                                                                       |
| Screen             | `b + s − b·s`                                                                               |
| Color Burn         | `1` if `b = 1`; `0` if `s = 0`; else `1 − min(1, (1 − b)/s)`                                |
| Linear Burn        | `max(0, b + s − 1)`                                                                         |
| Color Dodge        | `0` if `b = 0`; `1` if `s = 1`; else `min(1, b/(1 − s))`                                    |
| Linear Dodge (Add) | `min(1, b + s)` (32-bit: unclamped)                                                         |
| Overlay            | `2bs` if `b ≤ ½`, else `1 − 2(1 − b)(1 − s)`                                                |
| Soft Light         | `b − (1 − 2s)·b·(1 − b)` if `s ≤ ½`, else `b + (2s − 1)·(√b − b)`                           |
| Hard Light         | Overlay with `b` and `s` swapped                                                            |
| Vivid Light        | Color Burn with `2s` if `s ≤ ½`, else Color Dodge with `2(s − ½)`                           |
| Linear Light       | `clamp(b + 2s − 1)`                                                                         |
| Pin Light          | `min(b, 2s)` if `s ≤ ½`, else `max(b, 2s − 1)`                                              |
| Hard Mix           | `1` if `b + s ≥ 1`, else `0` (see §3.5 for Fill)                                            |
| Difference         | `\|b − s\|`                                                                                 |
| Exclusion          | `b + s − 2bs`                                                                               |
| Subtract           | `max(0, b − s)`                                                                             |
| Divide             | `min(1, b/s)`; `s = 0` gives `0` for `b = 0`, else `1` (32-bit: unclamped, capped at 65504) |

### 3.4 Whole-colour modes

These use the luminosity `Lum(c) = 0.3·r + 0.59·g + 0.11·b` and saturation `Sat(c) = max(c) − min(c)`.
`SetLum(c, l)` shifts all channels by `l − Lum(c)`, then pulls out-of-range colours back towards their luminosity
(below 0 always; above 1 except in 32-bit documents, where bright values are legitimate). `SetSat(c, s)` rescales the
channels so that min → 0, max → `s`, keeping the middle channel's relative position.

| Mode          | `B(b, s)`                                                        |
| ------------- | ---------------------------------------------------------------- |
| Darker Color  | whichever of `b`, `s` has the smaller channel sum (`b` on a tie) |
| Lighter Color | whichever has the larger channel sum (`b` on a tie)              |
| Hue           | `SetLum(SetSat(s, Sat(b)), Lum(b))`                              |
| Saturation    | `SetLum(SetSat(b, Sat(s)), Lum(b))`                              |
| Color         | `SetLum(s, Lum(b))`                                              |
| Luminosity    | `SetLum(b, Lum(s))`                                              |

In single-channel documents Darker/Lighter Color are min/max, and Hue/Saturation/Color/Luminosity are not offered.

### 3.5 Fill opacity and the "special eight"

For most modes Fill and Opacity both just scale the layer's alpha. For Color Burn, Linear Burn, Color Dodge, Linear
Dodge, Vivid Light, Linear Light, Hard Mix and Difference, Fill instead acts inside the formula: the layer colour is
first moved towards the mode's neutral colour — `s_f = n + (s − n)·f` with `n = 1` for the burns, `½` for Vivid/Linear
Light and `0` for the dodges and Difference — and only Opacity fades the result. Hard Mix with Fill `f < 1` becomes a
contrast ramp, `clamp((b − f·(1 − s)) / (1 − f))`, which is the full threshold at `f = 1`.

### 3.6 Dissolve

Each pixel is shown fully opaque or not at all: it shows when `noise(x, y) < α·o·f`, where `noise` is a fixed integer
hash of the document coordinates (`dissolveNoise` in `core/composite/blend.ts`, identical on the GPU), so the pattern
stays put when the document is panned, re-rendered or flattened.

### 3.7 Groups

Groups with a blend mode other than Pass Through are isolated: children are composited onto a transparent buffer,
which is then blended onto the backdrop as if it were one layer, with the group's mode, opacity and fill. Pass Through
groups composite their children directly onto the backdrop (so their modes see the layers below the group), and the
group opacity mixes between the backdrop before and after the group.

### 3.8 32-bit documents

Only Normal, Dissolve, Darken, Multiply, Lighten, Linear Dodge, Difference, Subtract, Divide, Darker/Lighter Color,
Hue, Saturation, Color and Luminosity are offered, as in the reference app. Results are not clamped at 1 where the
formula allows brighter values (Linear Dodge, Divide, whole-colour modes); Divide by black is capped at 65504.

### 3.9 GPU composite precision

The GPU compositor stores composites as half floats (RGBA16F); the CPU compositor (used for saving, merging and as
the test reference) works in 32/64-bit floats. Normal and Dissolve use hardware blending; every other mode runs a
shader pass that reads the backdrop and writes into a second texture. Across all modes the two agree to well within
one 8-bit step, except at a few pixels sitting exactly on a mode's threshold (Darker/Lighter Color ties, Hard Mix,
Dissolve) or near a division by almost zero (burns, dodges, Divide, Saturation), where the half-float backdrop can
tip the result: fewer than 0.25 % of values for threshold modes and 0.1 % for dividing modes in the tests.

## 4. Selections

A selection is an 8-bit mask over the document (0 = not selected, 255 = fully selected), stored as sparse
256 × 256 tiles plus a fill value (0 or 255) for everything else, on a grid with an integer offset (moving an
outline only changes the offset). Only the canvas counts: outside it nothing is selected.

- **Shapes** are filled with the even-odd rule. With anti-aliasing, a pixel's value is its coverage, measured on 4
  sub-rows per pixel with exact horizontal coverage on each; without it, a pixel is in when its centre is.
  Ellipses are polygons with segments about one pixel long.
- **Feather** blurs the new shape (before combining) with a Gaussian of standard deviation σ = the feather radius,
  approximated by three box blurs (box widths after Kovesi); outside the canvas counts as 0.
- **Combining** soft masks: Add `max(a, b)`, Intersect `min(a, b)`, Subtract `min(a, 255 − b)`; Inverse `255 − a`.
- **Selection-limited edits** move each pixel from its value `v` towards the edited value `e` by the mask:
  `v + (e − v)·m/255` (Invert); Clear multiplies alpha by `1 − m/255`, or moves colour towards the fill colour.
- **Marching ants** follow the edge between pixels with `m ≥ 128` and the rest, along pixel boundaries.

## 5. File formats

### 5.1 Opening (PNG, JPEG, WebP)

- Opaque images open as a locked **Background** layer; images with transparency open as a normal layer named
  **Layer 0**. Grayscale files open in Grayscale mode, colour files in RGB; 16-bit PNGs open as 16-bit documents.
- Resolution comes from PNG `pHYs` or the JPEG JFIF density (dots/inch or /cm); 72 ppi when absent.
- An embedded ICC profile is kept on the document and written back on save (not yet applied to colours, see
  KNOWN_GAPS).
- JPEG and WebP EXIF **orientation** (values 1–8) is applied on open, so photos appear upright.
- Palette PNGs are expanded to RGB(A) until Indexed Color mode exists; `tRNS` transparency becomes alpha.
- Decoding and tiling happen in the codec worker; fully transparent tiles are not stored.

### 5.2 Saving PNG

- Visible layers are flattened (§3) in the codec worker. The PNG has an alpha channel only if the flattened result has
  any transparency; otherwise it is RGB/Gray. 8- and 16-bit documents save at their own depth.
- Writes `pHYs` (document resolution) and `iCCP` (kept profile). Default compression: balanced.
- Not available for 32-bit, CMYK, Lab and other modes (PNG cannot store them), matching the reference app.
- The colour of fully transparent pixels is not preserved (it is invisible and dropped when flattening).

## 6. Image geometry and resampling

Image Size, Canvas Size, Crop and Image Rotation rebuild each layer on the document tile grid
(`core/geometry/layer-geometry.ts`, run in the pixel worker).

- **Exact maps** (Canvas Size, Crop, 90°/180° rotation, flips) copy pixels without filtering. A quarter turn clockwise
  sends old `(x, y)` to `(H − 1 − y, x)` on a canvas `W × H`; counter-clockwise to `(y, W − 1 − x)`.
- **Background vs. layers.** The Background always covers exactly the canvas: new canvas gets the extension colour
  (Canvas Size) or the background colour (a crop reaching past the canvas). Other layers keep pixels that end up
  outside the canvas (Canvas Size, Crop with Delete Cropped Pixels off); new areas are transparent.
- **Resampling** is separable: a horizontal pass, then a vertical one. Output pixel `i` samples the source at
  `(i + 0.5) / scale − 0.5`. When reducing, the filter is widened by `1 / scale` so every source pixel contributes
  (anti-aliasing); weights are normalised to sum to 1.
- **Kernels** (cubics in the Mitchell–Netravali family `k(B, C)`):

  | Method                         | Kernel                                                    |
  | ------------------------------ | --------------------------------------------------------- |
  | Nearest Neighbor               | nearest source pixel                                      |
  | Bilinear                       | triangle, radius 1                                        |
  | Bicubic (smooth gradients)     | `B = 0, C = 0.5` (Catmull-Rom)                            |
  | Bicubic Smoother (enlargement) | `B = 1/3, C = 1/3` (Mitchell)                             |
  | Bicubic Sharper (reduction)    | `B = 0, C = 0.75` (stronger edge overshoot)               |
  | Automatic                      | Smoother when enlarging, Sharper when reducing (per axis) |

- Filtering runs on **premultiplied** colour (colour × alpha), so transparent pixels never darken or tint edges;
  results are clamped to the sample range (8/16-bit) and left unclamped in 32-bit.
- Past the old canvas edge the Background **repeats its edge pixels**, so its borders keep their colour; layers
  with transparency read transparency there.
- Image > Crop uses the exact bounds of the pixels the selection touches at all (any value above 0).

### 6.1 Free Transform

- A transform is a projective 3 × 3 matrix in document coordinates (`core/geometry/transform.ts`); the box is the
  transformed layer bounds, and the matrix is the one sending the original rectangle's corners to the box's corners.
- Each output pixel centre goes back through the inverse matrix into the source and is sampled there (premultiplied,
  as in §6). Nearest Neighbor takes the source pixel; Bilinear and the bicubics use their kernels on 2 × 2 or 4 × 4
  source pixels. Where the output pixel covers more than one source pixel along a source axis (shrinking), the
  filter widens by that amount (up to 6×), so detail averages instead of aliasing.
- Bicubic Automatic: Smoother when enlarging, Sharper when shrinking, and plain Bicubic (Catmull-Rom, which passes
  exactly through the pixels) at the same size, so moves by whole pixels and quarter turns stay exact.
- The numbers in the options bar describe the affine part: width/height as a percentage of the original box
  (negative when flipped), the angle of its top edge, and the horizontal skew; the vertical skew is the typed value.
- With a selection, the selected pixels are lifted with their selection value (soft edges lift partly), and the
  selection itself is moved by the same transform (bilinear, so its edge stays smooth).

## 7. Saving and opening files (Phase 1 formats)

### 7.1 PSD / PSB (via ag-psd)

- **Opening** keeps: canvas size, resolution (`ResolutionInfo`, px/in or px/cm), bit depth 8/16/32, RGB or Grayscale,
  the layer tree (bottom → top) with names, visibility, opacity, fill opacity, blend modes (our ids are the PSD
  names with hyphens; groups may be Pass Through), group open/closed state and locks (transparency, pixels,
  position). Photoshop's 16-bit samples run 0–32768 and are scaled to our 0–65535.
- **The Background** is recognised as the bottom layer at the root that covers the whole canvas, is fully opaque and
  has locked transparency (or is named "Background"); it opens as our Background (no alpha).
- **Simplified on opening** (listed to the user): layer/vector masks and clipping (ignored), layer styles (ignored),
  text layers and smart objects (their stored pixels), adjustment and fill layers (left out). A file without layers
  opens from its composite image.
- **Saving** writes 8-bit RGB: each layer cropped to its visible pixels, RLE-compressed, the same properties, the
  Background as a bottom layer without transparency (locked), and a flattened composite for apps that do not read
  layers. ICC profiles are not written yet (KNOWN_GAPS).

### 7.2 JPEG (our encoder)

- Quality 0–12 maps to the usual 1–100 scale as 10, 18, 25, 32, 40, 50, 60, 70, 78, 85, 90, 95, 100; steps 0–6 also
  halve the colour resolution (4:2:0), 7–12 keep it (4:4:4). Quantisation tables are the standard's examples scaled
  by quality in the common way (`q < 50 ? 5000/q : 200 − 2q` percent).
- Baseline uses the standard's example Huffman tables; Baseline Optimized builds tables for the image (T.81 Annex
  K.2, at most 16-bit codes); Progressive sends DC first, then luminance detail in 2–4 bands (3–5 scans) and the
  colour detail, with optimised tables per scan (spectral selection only).
- Colour: RGB → YCbCr (JFIF/BT.601 full range); gray stays one component. Transparency is flattened over the matte
  colour (white unless chosen). JFIF records the resolution in pixels per inch; the ICC profile is written in APP2
  chunks. 16-bit images are written as 8-bit (JPEG holds 8 bits).
- Opening JPEGs now reads the JFIF resolution (the decoder library skipped it).

### 7.3 WebP

- Lossless: our Rust encoder (image-webp), exact, alpha kept, ICC profile embedded.
- Lossy (quality 0–100): the browser's encoder through an OffscreenCanvas in the codec worker; the ICC profile is then
  added by rewriting the file into the extended format (VP8X + ICCP chunks). Safari cannot encode WebP: lossless only.

## 8. Brushes

- **Tip frame.** A dab's pixel offset (dx, dy) from its centre (document px, y down) maps into the tip's frame by
  undoing the angle (counter-clockwise on screen): `u = dx·cos a − dy·sin a`, `v = dx·sin a + dy·cos a`; flips negate u
  or v; roundness divides v. The computed tip then reads the round profile at `hypot(u, v)` against radius `size/2`
  (hardness: solid core `h·r`, smoothstep rim, at least one pixel wide).
- **Sampled tips** store coverage 0–255. The tip's longer side spans `size` document pixels; the tip is read
  bilinearly from a pyramid of halved copies, using the level nearest one tip pixel per document pixel, so small
  dabs of large tips do not alias. Defining a tip (Edit > Define Brush Preset) takes the visible image under the
  selection: coverage = (1 − gray) × alpha × selection, gray = 0.299 R + 0.587 G + 0.114 B.
- **Coverage and opacity.** Each dab adds `flow × strength × tip` to the stroke's coverage c (`c ← c + (1 − c)·a`);
  the pixel is recomputed from its value before the stroke with `e = opacity × c × selection`, so a stroke never
  exceeds Opacity.
- **Brush modes.** With paint colour S and the pixel's colour B and alpha αb: the blend result `F = blend(B, S)`
  (the layer blend formulas, FORMAT_NOTES §3), then `α = e + αb(1 − e)` and
  `C = ((1 − αb)·e·S + αb·e·F + (1 − e)·αb·B) / α` — transparent pixels take the paint as is, as with a layer of paint.
  Where alpha cannot change (Background, locked transparency) `C = B + (F − B)·e`. Dissolve paints a pixel fully when
  its fixed noise value is below e (the same noise as the Dissolve blend mode). Behind: the pixel over the paint
  (`α = αb + e(1 − αb)`); Clear: `α = αb(1 − e)`; neither changes layers without editable transparency.
- **Pen samples** record x, y, pressure, tilt x/y (degrees), twist (degrees), wheel (0–1) and time (ms since the stroke
  began). Pens reported by altitude/azimuth (Safari) are converted: `tiltX = atan(cos az / tan alt)`,
  `tiltY = atan(sin az / tan alt)`.
- **Dynamics** (Brush Settings sections) change each dab after spacing places it. A control gives c in 0–1: Off 1;
  Fade `max(0, 1 − n/steps)` for the n-th dab; Pen Pressure p; Pen Tilt `1 − min(90, hypot(tiltX, tiltY))/90`
  (upright = 1); Stylus Wheel w; Rotation `twist/360`. A jittered value is
  `max(m, (m + (1 − m)·c) · (1 − j·r))` with jitter j, minimum m and a random r in [0, 1).
  - Shape: size × that value (Pen Tilt with Tilt Scale t instead grows the tip, `1 + t·lean`); angle adds the stroke
    direction, initial direction, tilt direction or twist (or scales by fade/pressure/wheel), then ± j·360°;
    roundness × the jittered value; flip jitter flips half the dabs.
  - Spacing follows the size the control alone sets (`m + (1 − m)·c`, no random part), so light-pressure and faded
    ends stay joined; random size jitter does not change the spacing.
  - Scattering moves a dab across the stroke by up to `amount × size × c` (and along it with Both Axes); Count dabs
    per placement, varied by Count Jitter.
  - Transfer: dab opacity = brush Opacity × the jittered value; flow (dab strength) × its jittered value.
  - Color Dynamics: the foreground leans to the background by `1 − c + j·r`; hue ± j·180°, saturation and
    brightness ± j, purity adds to saturation; per tip or once per stroke. The stroke keeps each dab's colour and
    opacity: new paint mixes over the colour so far by its share of the added coverage, and the opacity limit of a
    pixel is the highest of the dabs that touched it.
  - Brush Pose replaces the pen's tilt, rotation or pressure before the controls read them.
  - Random numbers come from mulberry32 seeded per stroke; the seed is recorded, so a replayed stroke is identical.
- **Texture.** The pattern's gray level g (luminance composited on white) becomes
  `t = clamp(((g − 127.5)·k + 127.5 + brightness) / 255)`, `k = 1 + contrast/25` (contrast ≥ 0) or `1 + contrast/50`,
  then `1 − t` with Invert. It is fixed to the document: pixel (x, y) reads the pattern bilinearly at
  `((x + 0.5)/scale − 0.5, (y + 0.5)/scale − 0.5)`, repeating. With paint amount a and depth d:
  Multiply `a·(1 − d(1 − t))`; Subtract `a − d(1 − t)`; Darken `min(a, 1 − d(1 − t))`; Overlay with
  `b = 0.5 + d(t − 0.5)`; Color Dodge `a / (1 − d·t)`; Color Burn `1 − (1 − a)/b`, `b = 1 − d(1 − t)`; Linear Burn
  `a − 2d(1 − t)`; Hard Mix `(a − d(1 − t)) / (1 − d)`; Height: paint reaches relief above `1 − L`,
  `L = a(1 + 4d)`, as `(t + L − 1)/0.25`; Linear Height `max(Height, a·t)` (all clamped to 0–1). Texture Each Tip
  applies this to each dab's amount before it is added (depth per dab with Depth Jitter, floored by Minimum Depth);
  otherwise to the stroke's coverage when shading.
- **Dual Brush.** Its dabs (own tip, size = share × brush size, spacing, scatter, count, random flips, own random
  stream from `seed ^ 0x5bd1e995`) build a coverage m of their own (`m ← m + (1 − m)·tip`). The stroke's coverage c
  becomes: Multiply `c·m`; Darken `min(c, m)`; Overlay (c base); Color Dodge `c/(1 − m)`; Color Burn
  `1 − (1 − c)/m`; Linear Burn `c + m − 1`; Hard Mix `(c + m − 1)/0.05`; Linear Height `max((m + c − 1)/0.25, c·m)`
  — all 0 where c is 0, so paint stays inside the stroke.
- **Noise** adds `(n − 0.5)·2·4a(1 − a)` to a tip's coverage a, with n a fixed hash of the document pixel.
- **Wet Edges.** Each dab is also laid shrunk by 10 % of its diameter on every side (minus a pixel) into an
  interior coverage i; with `k = i/c`, opacity = `max(c(0.5 + 0.4(1 − k)), min(c, 0.5 + 1.5(1 − c)))`: half in the
  middle, up to 90 % along a hard tip's rim, a darker ring where a soft tip's coverage is about 80 %.
- **Build-up.** While the pointer is down, its last sample is repeated every 16 ms with the current time (and
  recorded); the spacer adds a dab whenever 1/30 s has passed since the last one.
- **Symmetry.** A symmetry has a centre (cx, cy), an angle a (counter-clockwise on screen), a size s and segments n.
  In its frame `u = dx·cos a − dy·sin a`, `v = dx·sin a + dy·cos a` (dx, dy from the centre; y down). Each dab of a
  stroke is also painted at its images: mirror across the frame line at angle φ (`p' = 2(p·d)d − p`,
  `d = (cos φ, −sin φ)`), the tip's angle becoming `2(a + φ) − angle` with its Flip Y toggled; turn by α
  (`u' = u cos α + v sin α`, `v' = −u sin α + v cos α`), the tip turning by α. Vertical: φ = 90°; Horizontal: 0°;
  Dual Axis: both and a half turn; Diagonal: ±45° and a half turn; Radial: turns by k·360°/n; Mandala: those and
  mirrors at k·180°/n. Parallel Lines: mirrors across v = ±s/2. Circle: a point at radius r goes to `2s − r` on its
  ray (none if that is negative), mirrored across the tangent. Spiral `r = s·(θ/2π + k)`: across the nearest arm
  (`2·arm − r`), the tangent leaning `atan(2π·arm/s)` from the radius. Wavy `v = −(s/4)·sin(2πu/s)`: across the wave
  vertically (`v' = 2·wave − v`), mirrored across its slope. The copies are part of one stroke (one coverage, one
  History step); a stroke records its symmetry and replays it.

## 9. Brush preset files

- **Our .pfbrush file** is UTF-8 JSON: `{ "format": "pixelforge-brushes", "version": 1, "presets": [...], "tips":
[...], "patterns": [...] }`. A preset is `{ id, name, group, brush, toolSettings, smoothing? }` with `brush` as in a
  recorded stroke (size, hardness, opacity, flow, spacing, spacingEnabled, pressure toggles, angle, roundness, flips,
  tip id, mode, dynamics). Tips are `{ id, name, width, height, data }` with `data` the coverage bytes (one per pixel)
  in base64; patterns the same with RGBA bytes. Built-in tips (`pf-tip-…`) and patterns (`pf-…`) are not included.
  Readers refuse other formats and newer versions, and check every image's size.
- **ABR (versions 6–10)** as read by ag-psd: `8BIMsamp` sampled tips (8-bit coverage, raw or RLE), `8BIMpatt` patterns
  (RGB, grayscale or indexed) and `8BIMdesc`, a descriptor whose `Brsh` list holds the presets. Mapping: tip shape
  size, angle, roundness, hardness, spacing (and whether spacing is on), flips; sampled tips by their id; Shape
  Dynamics with Minimum Diameter / Minimum Roundness as the jitters' minimums; controls off, fade (with steps), pen
  pressure, pen tilt, stylus wheel, initial direction, direction, rotation (initial rotation → rotation); Scattering
  (the scatter jitter is the amount, up to 1000 %), count and count jitter; Texture (pattern id, invert, scale,
  brightness, contrast, mode, depth, minimum depth, depth jitter, each tip); Dual Brush (its tip, size as a share of
  the main size, spacing, scatter, count, flip, mode); Color Dynamics; Transfer (opacity and flow); Brush Pose; Noise
  and Wet Edges; tool options (opacity, flow, mode, pressure toggles, smoothing) make a preset with tool settings.

## 10. Swatch files

- **ASE** (big-endian): `ASEF`, version 1.0 (two u16), block count (u32); blocks of type (u16) and length (u32): group
  start `0xC001` (name: u16 length in UTF-16 units including the terminating 0, then UTF-16BE), group end `0xC002`,
  colour `0x0001` (name as above; model `RGB `, `CMYK`, `LAB ` or `Gray`; float32 values — RGB, CMYK and gray 0–1, Lab
  as L 0–1 (×100), a and b as they are; then a u16 type: global, spot, normal). Colours outside groups go into a group
  named after the file.
- **ACO** (big-endian): version 1 (u16), count (u16), then per colour a colour space (u16) and four u16 values;
  usually followed by the same list as version 2, each entry also carrying its name (u32 length in UTF-16 units
  including the terminating 0, then UTF-16BE). Spaces: 0 RGB (0–65535), 1 HSB (hue 0–65535 for 0–360°), 2 CMYK
  (stored as 65535 − ink), 7 Lab (L 0–10000, a and b signed ×100), 8 Grayscale (0–10000 = amount of black); others
  (custom inks) are skipped.

## 11. Gradients

**Evaluation** (`src/core/paint/gradient.ts`, D-045). A gradient is evaluated into a table of 4096 RGBA entries
(sRGB 0–1), then into the document's channel values (`gradientSamples`: RGB as is; Grayscale 0.299 R + 0.587 G +
0.114 B; 32-bit converted to linear light).

- Between stops a and b (sorted by location), with u = (t − a.location) / (b.location − a.location):
  u′ = u^(ln 0.5 / ln m), m = a's midpoint clamped to 0.05–0.95.
- Colours are mixed in a space chosen by the method: Perceptual and Smooth in Oklab (from linear sRGB, Björn
  Ottosson's matrices), Linear in linear light, Classic in sRGB values; Stripes takes a for u′ < 0.5, else b.
- Smooth: v = a + (b − a) · (3u′² − 2u′³).
- Perceptual, Linear, Classic: straight v₀ = a + (b − a) u′; spline v₁ = Hermite(u′; a, b, mₐ·span, m_b·span) with
  slopes per unit of location m_i = (v_{i+1} − v_{i−1}) / (loc_{i+1} − loc_{i−1}) inside, and half the end segment's
  slope at the ends; v₁ is clamped to [min(a, b), max(a, b)]; result v₀ + (v₁ − v₀) · smoothness.
- Opacity stops: the same, on the opacity values directly. Without Transparency, opacity is 1.
- Noise: per channel (and alpha) 2 + round(roughness · 62) random values from the seeded generator within
  [min, max]; linear between them, eased (3f² − 2f³) when roughness < 0.5. Models: RGB as is; HSB (h · 360°);
  Lab (L · 100, a and b · 255 − 128). Restrict Colors: saturation ≤ 0.8.

**Geometry**, from start S to end E (document coordinates, sampled at pixel centres), d = E − S, L = |d|, p = P − S:
linear t = p·d / L²; reflected |p·d| / L²; radial |p| / L; diamond (|p·d| + |p × d|) / L²; angle
atan2(p × d, p·d) / 2π wrapped to 0–1 (counter-clockwise on screen, y down). t is clamped to 0–1, then flipped by
Reverse. Between table entries the colour is interpolated linearly. Dither adds (h(x, y) − 0.5) / max to each channel,
h being a 32-bit integer hash of the pixel position.

**Action descriptors** (`src/io/descriptor.ts`, big-endian): Unicode string = u32 count of UTF-16 units (usually
with a trailing 0) + UTF-16BE; ID = u32 length, then that many ASCII bytes, or 0 then a four-character code.
Descriptor = name (Unicode), class ID, u32 item count, items of key ID + four-character type + value. Types: `Objc`
/ `GlbO` descriptor, `VlLs` list (u32 count, then type + value each), `doub` float64, `UntF` units (`#Prc`, `#Ang`,
`#Pxl`, …) + float64, `UnFl` units + u32 count + float64s, `TEXT` Unicode, `enum` type ID + value ID, `long` int32,
`comp` int64, `bool` u8, `type` / `GlbC` Unicode name + class ID, `alis` / `tdta` / `Pth ` u32 length + bytes,
`obj ` reference (u32 count of parts: `prop`, `Clss`, `Enmr`, `rele`, `Idnt`, `indx`, `name`).

**.grd files** (version 5): `8BGR`, u16 version 5, u32 16 (descriptor version), then a descriptor whose `GrdL` list
holds one object per gradient, the gradient (class `Grdn`) under the key `Grad`:

- `Nm  ` name (names starting `$$$/` are localisation keys; the text after `=` is shown), `GrdF` enum `GrdF`:
  `CstS` (solid) or `ClNs` (noise).
- Solid: `Intr` smoothness (0–4096), `Clrs` list of `Clrt` objects (`Clr ` colour object, `Type` enum `Clry`:
  `UsrS` user colour, `FrgC` foreground, `BckC` background; `Lctn` long 0–4096; `Mdpn` long 0–100), `Trns` list of
  `TrnS` objects (`Opct` `UntF #Prc` 0–100, `Lctn`, `Mdpn`).
- Colour objects: `RGBC` (`Rd  `, `Grn `, `Bl  ` 0–255, or `redFloat`… 0–1), `HSBC` (`H   ` `UntF #Ang`, `Strt`,
  `Brgh` 0–100), `CMYC` (`Cyn `, `Mgnt`, `Ylw `, `Blck` 0–100), `LbCl` (`Lmnc` 0–100, `A   `, `B   `), `Grsc`
  (`Gry ` 0–100, amount of black); colour-book colours (`BkCl`) hold no values.
- Noise: `ShTr` add transparency, `VctC` restrict colours, `ClrS` enum `ClrS` (`RGBC`, `HSBl`, `LbCl`), `RndS` seed,
  `Smth` roughness (0–4096), `Mnm ` / `Mxm ` lists of four longs 0–100 (the fourth unused).

## 12. Patterns

**Use**: pattern pixels (8-bit RGBA sRGB) become document values per pixel: RGB / 255 (32-bit: linear light),
Grayscale 0.299 R + 0.587 G + 0.114 B, alpha / 255. Edit > Fill repeats the pattern from document (0, 0): pattern
pixel ((x mod w), (y mod h)). The Pattern Stamp uses ((⌊x + 0.5 − ox⌋ mod w), (⌊y + 0.5 − oy⌋ mod h)) with the origin
(ox, oy) = (0, 0) when Aligned, else the pixel where the stroke began; the effective paint opacity is multiplied by
the pattern's alpha. Impressionist: the dab's colour is the pattern pixel at the dab centre.

**.pat files** (big-endian): `8BPT`, u16 version 1, u32 pattern count, then per pattern (possibly preceded by its
length and padded to 4 bytes, as inside PSD files): u32 version 1, u32 image mode (0 bitmap, 1 grayscale, 2 indexed,
3 RGB, 4 CMYK, 7 multichannel, 8 duotone, 9 Lab), u16 height, u16 width, name (Unicode string as in §11), id (Pascal
string: u8 length + ASCII); for indexed, 768 bytes of palette and 4 more bytes; then the virtual memory array list:
u32 version 3, u32 length, rectangle (u32 top, left, bottom, right), u32 channel count, then for each of channel
count + 2 arrays (the last two: user and sheet masks): u32 written flag (nothing follows when 0), u32 length, u32
depth (8 or 16), rectangle (4 × u32), u16 depth, u8 compression (0 raw, 1 RLE: a u16 byte count per row, then PackBits
rows), data. 16-bit values are big-endian. CMYK channels hold 255 − ink. We read the colour channels from the first
written arrays and the transparency from the next written one; we write 24 channel slots with R, G, B (and alpha when
the pattern has transparency) written raw and the rest unwritten.

## 13. Paint Bucket

**Area**: with the clicked pixel's premultiplied composite value t (channels and alpha, 0–1, each clamped to ≤ 1) and
a pixel's value p, its distance is d = round(255 · max over channels and alpha of |p − t|). Without Anti-alias the
area is { d ≤ Tolerance } (Contiguous: the part joined to the click through 4-neighbours). With Anti-alias, each pixel
outside the area with a 4-neighbour inside it gets coverage round(255 · (1 − (d − Tolerance) / (255 − Tolerance))),
at most 254, when positive. The coverage is then multiplied by the selection value / 255 (pixels where the selection
is 0 are never part of the area). The compared composite is the active layer alone (visible, opacity 1, fill 1,
Normal) or, with All Layers, the visible document.

**Fill**: Edit > Fill's blend (§3.2 formulas through `blendSourceTiles`) of the foreground colour or the pattern
(repeated from document (0, 0)) with the tool's mode and opacity, through the coverage as a mask; Behind and Clear as
for the Gradient tool; locked transparency keeps alpha.
