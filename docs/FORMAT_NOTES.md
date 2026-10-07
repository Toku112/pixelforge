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

## 4. File formats

### 4.1 Opening (PNG, JPEG, WebP)

- Opaque images open as a locked **Background** layer; images with transparency open as a normal layer named
  **Layer 0**. Grayscale files open in Grayscale mode, colour files in RGB; 16-bit PNGs open as 16-bit documents.
- Resolution comes from PNG `pHYs` or the JPEG JFIF density (dots/inch or /cm); 72 ppi when absent.
- An embedded ICC profile is kept on the document and written back on save (not yet applied to colours, see
  KNOWN_GAPS).
- JPEG and WebP EXIF **orientation** (values 1–8) is applied on open, so photos appear upright.
- Palette PNGs are expanded to RGB(A) until Indexed Color mode exists; `tRNS` transparency becomes alpha.
- Decoding and tiling happen in the codec worker; fully transparent tiles are not stored.

### 4.2 Saving PNG

- Visible layers are flattened (§3) in the codec worker. The PNG has an alpha channel only if the flattened result has
  any transparency; otherwise it is RGB/Gray. 8- and 16-bit documents save at their own depth.
- Writes `pHYs` (document resolution) and `iCCP` (kept profile). Default compression: balanced.
- Not available for 32-bit, CMYK, Lab and other modes (PNG cannot store them), matching the reference app.
- The colour of fully transparent pixels is not preserved (it is invisible and dropped when flattening).
