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

/** Inverse of M (XYZ D50 → linear sRGB), computed once. */
const M_INV = (() => {
  const [a, b, c] = M[0];
  const [d, e, f] = M[1];
  const [g, h, i] = M[2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
})();

function fInverse(t: number): number {
  return t ** 3 > EPSILON ? t ** 3 : (116 * t - 16) / KAPPA;
}

/** Converts L*a*b* (D50) to linear-light sRGB (values outside 0–1 are out of the sRGB gamut). */
export function labToLinearSrgb(lab: Lab): [number, number, number] {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const X = fInverse(fx) * D50_WHITE.X;
  const Y = (lab.L > KAPPA * EPSILON ? fy ** 3 : lab.L / KAPPA) * D50_WHITE.Y;
  const Z = fInverse(fz) * D50_WHITE.Z;
  const m = M_INV;
  return [
    m[0]![0]! * X + m[0]![1]! * Y + m[0]![2]! * Z,
    m[1]![0]! * X + m[1]![1]! * Y + m[1]![2]! * Z,
    m[2]![0]! * X + m[2]![1]! * Y + m[2]![2]! * Z,
  ];
}
