/**
 * CIE L*a*b* conversions, D50 reference white (the ICC profile connection space,
 * also used by the reference app's Lab mode).
 *
 * Linear sRGB → XYZ uses the sRGB primaries chromatically adapted from D65 to D50
 * with the Bradford transform. Full ICC-based conversion arrives with colour
 * management (Phase 7); this is the fixed sRGB path used for measurements and tests.
 */

export interface Lab {
  L: number;
  a: number;
  b: number;
}

/**
 * D50 reference white, Y normalised to 1. These are the row sums of the matrix below,
 * so sRGB white maps to exactly a* = b* = 0 (ICC rounds the same point to 0.9642, 0.8249).
 */
export const D50_WHITE = { X: 0.96422, Y: 1.0, Z: 0.82521 } as const;

// Linear sRGB → XYZ (D50), Bradford-adapted. Rows give X, Y, Z.
const M = [
  [0.436074716, 0.385064915, 0.143080403],
  [0.222504478, 0.716878669, 0.060616852],
  [0.013932173, 0.097104526, 0.714173298],
] as const;

const EPSILON = 216 / 24389; // (6/29)^3
const KAPPA = 24389 / 27; // (29/3)^3

function f(t: number): number {
  return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

/** Converts linear-light sRGB (0–1, may exceed 1 for HDR) to L*a*b* (D50). */
export function linearSrgbToLab(r: number, g: number, b: number, out: Lab = { L: 0, a: 0, b: 0 }): Lab {
  const X = M[0][0] * r + M[0][1] * g + M[0][2] * b;
  const Y = M[1][0] * r + M[1][1] * g + M[1][2] * b;
  const Z = M[2][0] * r + M[2][1] * g + M[2][2] * b;
  const fx = f(X / D50_WHITE.X);
  const fy = f(Y / D50_WHITE.Y);
  const fz = f(Z / D50_WHITE.Z);
  out.L = 116 * fy - 16;
  out.a = 500 * (fx - fy);
  out.b = 200 * (fy - fz);
  return out;
}
