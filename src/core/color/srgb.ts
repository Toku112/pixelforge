/**
 * sRGB transfer function (IEC 61966-2-1). Values are normalised to 0–1.
 * Out-of-range input (e.g. HDR values above 1) is extended symmetrically so the
 * functions stay monotonic and invertible.
 */

/** Gamma-encoded sRGB → linear light. */
export function srgbToLinear(v: number): number {
  const a = Math.abs(v);
  const lin = a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4;
  return v < 0 ? -lin : lin;
}

/** Linear light → gamma-encoded sRGB. */
export function linearToSrgb(v: number): number {
  const a = Math.abs(v);
  const enc = a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055;
  return v < 0 ? -enc : enc;
}

let lut8: Float32Array | undefined;
let lut16: Float32Array | undefined;

/** Lookup table: 8-bit sRGB code value → linear light. */
export function srgb8ToLinearTable(): Float32Array {
  if (!lut8) {
    lut8 = new Float32Array(256);
    for (let i = 0; i < 256; i++) lut8[i] = srgbToLinear(i / 255);
  }
  return lut8;
}

/** Lookup table: 16-bit (0–65535) sRGB code value → linear light. */
export function srgb16ToLinearTable(): Float32Array {
  if (!lut16) {
    lut16 = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) lut16[i] = srgbToLinear(i / 65535);
  }
  return lut16;
}
