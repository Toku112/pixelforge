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

## 3. Blend modes

_Documented as each mode is implemented._

## 4. File formats

_Documented as each codec is implemented._
