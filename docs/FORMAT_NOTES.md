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

### 3.2 Groups

Groups with a blend mode other than Pass Through are isolated: children are composited onto a transparent buffer, which
is then composited onto the backdrop with the group's opacity. Pass Through groups composite their children directly
onto the backdrop, and the group opacity mixes between the backdrop before and after the group. With only the Normal
mode the two give identical results; they differ once other modes are used.

_Other blend modes are documented as they are implemented (Phase 1)._

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
