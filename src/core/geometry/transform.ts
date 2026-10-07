/**
 * Plane transforms for Free Transform: 3 × 3 projective matrices (row-major) that
 * cover moving, scaling, rotating, skewing, distorting and perspective.
 *
 *   x' = (m0·x + m1·y + m2) / (m6·x + m7·y + m8)
 *   y' = (m3·x + m4·y + m5) / (m6·x + m7·y + m8)
 *
 * A transform is usually described by where it sends the corners of a rectangle
 * (the transformed layer's bounds): `rectToQuad`.
 */
import type { Rect } from '../document/geometry';

export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export interface Point {
  x: number;
  y: number;
}

/** Corners in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = readonly [Point, Point, Point, Point];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function multiply(a: Mat3, b: Mat3): Mat3 {
  const m = new Array<number>(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      m[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return m as unknown as Mat3;
}

/** The inverse, or null when the matrix is singular (a collapsed transform). */
export function invert(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [
    A * k,
    -(b * i - c * h) * k,
    (b * f - c * e) * k,
    B * k,
    (a * i - c * g) * k,
    -(a * f - c * d) * k,
    C * k,
    -(a * h - b * g) * k,
    (a * e - b * d) * k,
  ];
}

export function apply(m: Mat3, p: Point): Point {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  return { x: (m[0] * p.x + m[1] * p.y + m[2]) / w, y: (m[3] * p.x + m[4] * p.y + m[5]) / w };
}

export const translation = (dx: number, dy: number): Mat3 => [1, 0, dx, 0, 1, dy, 0, 0, 1];
export const scaling = (sx: number, sy: number): Mat3 => [sx, 0, 0, 0, sy, 0, 0, 0, 1];
export function rotation(radians: number): Mat3 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** `m` applied about point `p` (moved to the origin, transformed, moved back). */
export function about(p: Point, m: Mat3): Mat3 {
  return multiply(translation(p.x, p.y), multiply(m, translation(-p.x, -p.y)));
}

/** The transform sending the unit square's corners (0,0) (1,0) (1,1) (0,1) to `q`. */
function squareToQuad(q: Quad): Mat3 | null {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    // A parallelogram: affine.
    return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0, 1];
  }
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) < 1e-12) return null;
  const g = (sx * dy2 - dx2 * sy) / det;
  const h = (dx1 * sy - sx * dy1) / det;
  return [
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
    1,
  ];
}

/** The transform sending rectangle `r`'s corners to `q` (null if `q` is degenerate). */
export function rectToQuad(r: Rect, q: Quad): Mat3 | null {
  const s = squareToQuad(q);
  if (!s) return null;
  return multiply(s, multiply(scaling(1 / r.w, 1 / r.h), translation(-r.x, -r.y)));
}

export function quadOf(m: Mat3, r: Rect): Quad {
  return [
    apply(m, { x: r.x, y: r.y }),
    apply(m, { x: r.x + r.w, y: r.y }),
    apply(m, { x: r.x + r.w, y: r.y + r.h }),
    apply(m, { x: r.x, y: r.y + r.h }),
  ];
}

/**
 * Whether `q` is a usable shape: convex, not collapsed, and not passing through the
 * horizon (all four corners turn the same way).
 */
export function isValidQuad(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) return false;
    const s = Math.sign(cross);
    if (sign !== 0 && s !== sign) return false;
    sign = s;
  }
  return true;
}

/** The axis-aligned box around points. */
export function boundsOf(points: readonly Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/**
 * The options-bar numbers of a transform of rectangle `r`: scale (1 = 100 %, negative
 * when flipped), rotation and skews in degrees. Read from the top-left corner's
 * edges, so they describe the affine part (exact unless distorted); `skewV` is the
 * vertical skew the caller keeps (it cannot be told apart from rotation).
 */
export interface AffineParts {
  scaleX: number;
  scaleY: number;
  angle: number;
  skewH: number;
  skewV: number;
}

const DEG = 180 / Math.PI;

export function affineParts(q: Quad, r: Rect, skewV = 0): AffineParts {
  const ex = { x: q[1].x - q[0].x, y: q[1].y - q[0].y };
  const ey = { x: q[3].x - q[0].x, y: q[3].y - q[0].y };
  const tv = Math.tan(skewV / DEG);
  // ex = sx·R(a)·(1, tv); ey = sy·R(a)·(th, 1)
  const a = Math.atan2(ex.y, ex.x) - Math.atan(tv);
  const sx = Math.hypot(ex.x, ex.y) / Math.hypot(1, tv) / r.w;
  const c = Math.cos(-a);
  const s = Math.sin(-a);
  const ux = c * ey.x - s * ey.y;
  const uy = s * ey.x + c * ey.y;
  const sy = uy / r.h;
  const th = uy !== 0 ? ux / uy : 0;
  return { scaleX: sx, scaleY: sy, angle: a * DEG, skewH: Math.atan(th) * DEG, skewV };
}

/** The affine transform (about the rectangle's top-left corner, then moved there) with these parts. */
export function affineFromParts(parts: AffineParts, r: Rect, topLeft: Point): Mat3 {
  const k: Mat3 = [1, Math.tan(parts.skewH / DEG), 0, Math.tan(parts.skewV / DEG), 1, 0, 0, 0, 1];
  const local = multiply(rotation(parts.angle / DEG), multiply(k, scaling(parts.scaleX, parts.scaleY)));
  return multiply(translation(topLeft.x, topLeft.y), multiply(local, translation(-r.x, -r.y)));
}
