/**
 * Paint symmetry: each dab of a stroke is also painted at its mirror images.
 *
 * Behaviour (own summary of the reference app):
 * - Types: Vertical and Horizontal (one mirror line), Dual Axis (both), Diagonal
 *   (two diagonal lines), Wavy (a wave), Circle (mirrored across the circle's
 *   edge), Spiral (across the spiral's arm), Parallel Lines (two parallel mirror
 *   lines), Radial (2–12 turned copies) and Mandala (2–12 turned and mirrored
 *   copies, like a kaleidoscope).
 * - The symmetry's guide can be moved, turned and scaled; Brush, Pencil and Eraser
 *   strokes paint every copy as one stroke (one History step, never past Opacity).
 *   Tips are mirrored too.
 *
 * A symmetry is described in document pixels: centre, angle (degrees,
 * counter-clockwise on screen), size (circle radius, spiral turn spacing, wave
 * length, parallel line spacing; also the guide's scale) and segments.
 */
import type { Dab } from './brush';

export type SymmetryKind =
  'vertical' | 'horizontal' | 'dual' | 'diagonal' | 'wavy' | 'circle' | 'spiral' | 'parallel' | 'radial' | 'mandala';

export const SYMMETRY_KINDS: readonly [SymmetryKind, string][] = [
  ['vertical', 'Vertical'],
  ['horizontal', 'Horizontal'],
  ['dual', 'Dual Axis'],
  ['diagonal', 'Diagonal'],
  ['wavy', 'Wavy'],
  ['circle', 'Circle'],
  ['spiral', 'Spiral'],
  ['parallel', 'Parallel Lines'],
  ['radial', 'Radial'],
  ['mandala', 'Mandala'],
];

export interface Symmetry {
  kind: SymmetryKind;
  cx: number;
  cy: number;
  /** Degrees, counter-clockwise on screen. */
  angle: number;
  /** Document px (> 0). */
  size: number;
  /** Radial and Mandala: 2–12. */
  segments: number;
  /** Turned off keeps the guide for later. */
  enabled: boolean;
}

/** Whether a type asks for a segment count. */
export const hasSegments = (kind: SymmetryKind) => kind === 'radial' || kind === 'mandala';

/** A new symmetry of a type, centred on a canvas of `width` × `height`. */
export function defaultSymmetry(kind: SymmetryKind, width: number, height: number, segments = 5): Symmetry {
  const m = Math.min(width, height);
  const size =
    kind === 'circle'
      ? m / 3
      : kind === 'spiral'
        ? m / 8
        : kind === 'wavy'
          ? m / 2
          : kind === 'parallel'
            ? m / 3
            : m / 2;
  return { kind, cx: width / 2, cy: height / 2, angle: 0, size, segments, enabled: true };
}

const DEG = Math.PI / 180;

/** The symmetry's own frame: u along its angle, v across it (screen-like, y down). */
function frame(s: Symmetry) {
  const c = Math.cos(s.angle * DEG);
  const n = Math.sin(s.angle * DEG);
  return {
    toLocal: (x: number, y: number) => ({ u: (x - s.cx) * c - (y - s.cy) * n, v: (x - s.cx) * n + (y - s.cy) * c }),
    toWorld: (u: number, v: number) => ({ x: s.cx + u * c + v * n, y: s.cy - u * n + v * c }),
  };
}

/** One copy: where a dab goes, and how its tip turns (rotation) or mirrors (across a line at an angle). */
type Copy = (dab: Dab) => Dab | null;

const wrap = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

/** A dab mirrored across a line at `lineDeg` (world, counter-clockwise) to `x, y`. */
const mirrored = (d: Dab, x: number, y: number, lineDeg: number): Dab => ({
  ...d,
  x,
  y,
  angle: wrap(2 * lineDeg - d.angle),
  flipY: !d.flipY,
});

/** The mirror copies of a symmetry (the first is the dab itself). */
export function symmetryCopies(s: Symmetry): Copy[] {
  const f = frame(s);
  const identity: Copy = (d) => d;
  /** Mirror across the line through the centre at local angle `phi` (degrees). */
  const reflect =
    (phi: number): Copy =>
    (d) => {
      const { u, v } = f.toLocal(d.x, d.y);
      const dx = Math.cos(phi * DEG);
      const dy = -Math.sin(phi * DEG);
      const dot = u * dx + v * dy;
      const w = f.toWorld(2 * dot * dx - u, 2 * dot * dy - v);
      return mirrored(d, w.x, w.y, s.angle + phi);
    };
  /** Turned about the centre by `alpha` degrees. */
  const rotate =
    (alpha: number): Copy =>
    (d) => {
      const { u, v } = f.toLocal(d.x, d.y);
      const c = Math.cos(alpha * DEG);
      const n = Math.sin(alpha * DEG);
      const w = f.toWorld(u * c + v * n, -u * n + v * c);
      return { ...d, x: w.x, y: w.y, angle: wrap(d.angle + alpha) };
    };
  const n = Math.max(2, Math.min(12, Math.round(s.segments)));
  switch (s.kind) {
    case 'vertical':
      return [identity, reflect(90)];
    case 'horizontal':
      return [identity, reflect(0)];
    case 'dual':
      return [identity, reflect(90), reflect(0), rotate(180)];
    case 'diagonal':
      return [identity, reflect(45), reflect(-45), rotate(180)];
    case 'radial':
      return Array.from({ length: n }, (_, k) => (k === 0 ? identity : rotate((k * 360) / n)));
    case 'mandala':
      return [
        ...Array.from({ length: n }, (_, k) => (k === 0 ? identity : rotate((k * 360) / n))),
        ...Array.from({ length: n }, (_, k) => reflect((k * 180) / n)),
      ];
    case 'parallel':
      return [
        identity,
        ...[s.size / 2, -s.size / 2].map((c): Copy => (d) => {
          const { u, v } = f.toLocal(d.x, d.y);
          const w = f.toWorld(u, 2 * c - v);
          return mirrored(d, w.x, w.y, s.angle);
        }),
      ];
    case 'circle':
      return [
        identity,
        (d) => {
          // Across the circle's edge: as far outside as the dab is inside (and back).
          const { u, v } = f.toLocal(d.x, d.y);
          const r = Math.hypot(u, v);
          const t = Math.atan2(-v, u);
          const r2 = 2 * s.size - r;
          if (r2 < 0) return null;
          const w = f.toWorld(r2 * Math.cos(t), -r2 * Math.sin(t));
          return mirrored(d, w.x, w.y, s.angle + t / DEG + 90);
        },
      ];
    case 'spiral':
      return [
        identity,
        (d) => {
          // Archimedean spiral r = size × turns; across the nearest arm.
          const { u, v } = f.toLocal(d.x, d.y);
          const r = Math.hypot(u, v);
          let t = Math.atan2(-v, u);
          if (t < 0) t += 2 * Math.PI;
          const k = Math.max(0, Math.round(r / s.size - t / (2 * Math.PI)));
          const arm = s.size * (t / (2 * Math.PI) + k);
          const r2 = 2 * arm - r;
          if (r2 < 0) return null;
          const w = f.toWorld(r2 * Math.cos(t), -r2 * Math.sin(t));
          // The arm's direction leans from the radial by atan(2π·r / size).
          return mirrored(d, w.x, w.y, s.angle + (t + Math.atan((2 * Math.PI * arm) / s.size)) / DEG);
        },
      ];
    case 'wavy':
      return [
        identity,
        (d) => {
          // A wave along the guide (wave length = size, height a quarter of it, rising first on
          // screen); across it vertically.
          const { u, v } = f.toLocal(d.x, d.y);
          const k = (2 * Math.PI) / s.size;
          const a = s.size / 4;
          const wave = -a * Math.sin(k * u);
          const w = f.toWorld(u, 2 * wave - v);
          const slope = -a * k * Math.cos(k * u);
          return mirrored(d, w.x, w.y, s.angle - Math.atan(slope) / DEG);
        },
      ];
  }
}

/** Every copy of the dabs (the originals first), dropping copies that fall nowhere. */
export function applySymmetry(dabs: readonly Dab[], copies: readonly Copy[]): Dab[] {
  const out: Dab[] = [];
  copies.forEach((copy, i) => {
    for (const d of dabs) {
      const c = copy(d);
      // Mirror images say which copy they belong to (the Mixer Brush keeps paint per copy).
      if (c) out.push(i === 0 ? c : { ...c, copy: i });
    }
  });
  return out;
}

/** The guide as polylines in document coordinates (`reach`: how far lines extend from the centre). */
export function symmetryGuide(s: Symmetry, reach: number): { points: number[]; closed: boolean }[] {
  const f = frame(s);
  const line = (phi: number, from = -reach) => {
    const dx = Math.cos(phi * DEG);
    const dy = -Math.sin(phi * DEG);
    const a = f.toWorld(dx * from, dy * from);
    const b = f.toWorld(dx * reach, dy * reach);
    return { points: [a.x, a.y, b.x, b.y], closed: false };
  };
  const curve = (count: number, at: (i: number) => { u: number; v: number }, closed = false) => {
    const points: number[] = [];
    for (let i = 0; i <= count; i++) {
      const { u, v } = at(i);
      const w = f.toWorld(u, v);
      points.push(w.x, w.y);
    }
    return { points, closed };
  };
  const n = Math.max(2, Math.min(12, Math.round(s.segments)));
  switch (s.kind) {
    case 'vertical':
      return [line(90)];
    case 'horizontal':
      return [line(0)];
    case 'dual':
      return [line(0), line(90)];
    case 'diagonal':
      return [line(45), line(-45)];
    case 'radial':
      return Array.from({ length: n }, (_, k) => line((k * 360) / n, 0));
    case 'mandala':
      return Array.from({ length: n }, (_, k) => line((k * 180) / n));
    case 'parallel':
      return [-1, 1].map((side) => {
        const a = f.toWorld(-reach, (side * s.size) / 2);
        const b = f.toWorld(reach, (side * s.size) / 2);
        return { points: [a.x, a.y, b.x, b.y], closed: false };
      });
    case 'circle':
      return [
        curve(
          96,
          (i) => ({ u: s.size * Math.cos((i / 96) * 2 * Math.PI), v: s.size * Math.sin((i / 96) * 2 * Math.PI) }),
          true,
        ),
      ];
    case 'spiral': {
      const turns = Math.min(200, Math.ceil(reach / s.size));
      const steps = turns * 64;
      return [
        curve(steps, (i) => {
          const t = (i / 64) * 2 * Math.PI;
          const r = s.size * (t / (2 * Math.PI));
          return { u: r * Math.cos(t), v: -r * Math.sin(t) };
        }),
      ];
    }
    case 'wavy': {
      const steps = Math.min(4000, Math.ceil(((2 * reach) / s.size) * 32));
      return [
        curve(steps, (i) => {
          const u = -reach + (2 * reach * i) / steps;
          return { u, v: -(s.size / 4) * Math.sin(((2 * Math.PI) / s.size) * u) };
        }),
      ];
    }
  }
}

const KINDS = SYMMETRY_KINDS.map(([k]) => k);

/** A recorded symmetry, checked. */
export function parseSymmetry(raw: unknown): Symmetry {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const num = (key: string, lo: number, hi: number) => {
    const v = r[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
      throw new Error(`symmetry: ${key} must be ${lo}–${hi}`);
    return v;
  };
  if (!KINDS.includes(r['kind'] as SymmetryKind)) throw new Error('symmetry: unknown kind');
  return {
    kind: r['kind'] as SymmetryKind,
    cx: num('cx', -1e7, 1e7),
    cy: num('cy', -1e7, 1e7),
    angle: num('angle', -360, 360),
    size: num('size', 0.5, 1e7),
    segments: r['segments'] === undefined ? 5 : Math.round(num('segments', 2, 12)),
    enabled: r['enabled'] !== false,
  };
}
