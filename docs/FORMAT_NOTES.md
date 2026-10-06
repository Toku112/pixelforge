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

## 2. Blend modes

_Documented as each mode is implemented._

## 3. File formats

_Documented as each codec is implemented._
