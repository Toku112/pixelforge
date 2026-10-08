/**
 * Brush maths: tips and dab profiles, placing dabs along a stroke, and the size and
 * hardness steps of the [ ] { } keys.
 *
 * Behaviour (own summary of the reference app):
 * - A stroke is a series of dabs, `spacing` × diameter apart along the path.
 * - The computed tip is round, or elliptical with Roundness below 100 %, turned by
 *   Angle (counter-clockwise on screen) and optionally flipped. Hardness is the share
 *   of the radius that is fully solid; the rest fades out smoothly to the edge.
 * - A sampled tip is a grayscale picture (dark = paint) defined from the image; its
 *   size is the longer side; Hardness does not apply.
 * - Pen pressure can scale the size and/or the opacity of each dab (options bar).
 * - Mode blends the paint into the pixels like a layer blend mode; Behind paints only
 *   where the layer is transparent, Clear makes pixels transparent.
 * - [ and ] change the size in steps that grow with the size; Shift+[ / ] change
 *   the hardness by 25 %.
 */
import type { LayerBlendMode } from '../document/layers';
import type { BrushDynamics } from './dynamics';

/** How paint combines with the pixels: a blend mode, or Behind / Clear. */
export type BrushMode = LayerBlendMode | 'behind' | 'clear';

export interface BrushSettings {
  /** Diameter, px (1–5000). */
  size: number;
  /** 0–1. */
  hardness: number;
  /** Maximum coverage a stroke builds up to, 0–1. */
  opacity: number;
  /** Coverage each dab adds, 0–1. */
  flow: number;
  /** Distance between dabs as a fraction of the diameter (0.01–10). */
  spacing: number;
  /** Pen pressure scales the size / the opacity of each dab. */
  pressureSize: boolean;
  pressureOpacity: boolean;
  /** Tip angle, degrees (−180–180), counter-clockwise. */
  angle: number;
  /** Height of the tip as a share of its width (0.01–1). */
  roundness: number;
  flipX: boolean;
  flipY: boolean;
  /** A sampled tip's id, or null for the computed round tip. */
  tip: string | null;
  mode: BrushMode;
  /** How dabs vary (Brush Settings panel); absent or all off: they do not. */
  dynamics?: BrushDynamics;
}

export const DEFAULT_BRUSH: Readonly<BrushSettings> = Object.freeze({
  size: 30,
  hardness: 1,
  opacity: 1,
  flow: 1,
  spacing: 0.25,
  pressureSize: false,
  pressureOpacity: false,
  angle: 0,
  roundness: 1,
  flipX: false,
  flipY: false,
  tip: null,
  mode: 'normal',
});

/** One dab: centre (document px), diameter (px), strength (0–1, multiplies flow) and tip pose. */
export interface Dab {
  x: number;
  y: number;
  size: number;
  strength: number;
  /** Degrees, counter-clockwise. */
  angle: number;
  roundness: number;
  flipX: boolean;
  flipY: boolean;
  /** This dab's opacity limit (Transfer dynamics; default: the brush Opacity). */
  opacity?: number;
  /** This dab's colour samples (Color Dynamics; default: the brush colour). */
  color?: number[];
  /** This dab's texture depth (Texture Each Tip with Depth Jitter; default: the texture's Depth). */
  depth?: number;
  /** A Dual Brush dab: it masks the stroke instead of painting. */
  dual?: boolean;
}

/** A dab where the spacer put it, with what dynamics need: the pen there, its number and the stroke direction. */
export interface PlacedDab {
  dab: Dab;
  point: StrokePoint;
  index: number;
  /** Radians, screen (y down). */
  direction: number;
  initialDirection: number;
}

/**
 * A pointer sample of a stroke: document position; pressure 0–1 (1 for a mouse);
 * pen tilt in degrees (−90–90 along x and y, 0 upright); twist (barrel rotation,
 * 0–359°); stylus wheel 0–1; time in ms since the stroke began.
 */
export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  twist: number;
  wheel: number;
  time: number;
}

/** A mouse-like sample (no tilt, full pressure) at (x, y). */
export function strokePoint(x: number, y: number, pressure = 1, time = 0): StrokePoint {
  return { x, y, pressure, tiltX: 0, tiltY: 0, twist: 0, wheel: 0, time };
}

/** Values recorded per sample in stroke descriptors, in this order. */
export const POINT_FIELDS = ['x', 'y', 'pressure', 'tiltX', 'tiltY', 'twist', 'wheel', 'time'] as const;

/** Flattens samples for a descriptor (stride POINT_FIELDS.length). */
export function packPoints(points: readonly StrokePoint[]): number[] {
  return points.flatMap((p) => POINT_FIELDS.map((f) => p[f]));
}

/** Reads samples from a descriptor; `stride` 3 is the older x, y, pressure form. */
export function unpackPoints(values: readonly number[], stride: number): StrokePoint[] {
  const out: StrokePoint[] = [];
  for (let i = 0; i + stride <= values.length; i += stride) {
    const p = strokePoint(values[i]!, values[i + 1]!, values[i + 2]);
    if (stride >= POINT_FIELDS.length) {
      p.tiltX = values[i + 3]!;
      p.tiltY = values[i + 4]!;
      p.twist = values[i + 5]!;
      p.wheel = values[i + 6]!;
      p.time = values[i + 7]!;
    }
    out.push(p);
  }
  return out;
}

/** A sampled brush tip: coverage 0–255 (255 = full paint), `width` × `height`. */
export interface BrushTip {
  id: string;
  name: string;
  width: number;
  height: number;
  data: Uint8Array;
}

/** Largest side of a sampled tip, px. */
export const MAX_TIP_SIDE = 2500;

/**
 * Coverage (0–1) of a dab at distance `d` from its centre, for radius `r` and
 * hardness `h`. The solid core reaches h·r; beyond it a smoothstep falls to 0 at
 * r. Edges get at least a one-pixel anti-aliased ramp.
 */
export function dabCoverage(d: number, r: number, h: number): number {
  if (d >= r + 0.5) return 0;
  const soft = Math.max(1, (1 - h) * r); // width of the fading rim, px
  const inner = r - soft;
  if (d <= inner - 0.5) return 1;
  // Hard-ish edges: coverage of the pixel by a ramp half a pixel either side of the edge.
  const t = Math.min(1, Math.max(0, (r + 0.5 - d) / (soft + 1)));
  return t * t * (3 - 2 * t);
}

/**
 * Places dabs along a stroke. Keeps the distance travelled since the last dab
 * between calls, so a stroke can be fed in pieces as the pointer moves.
 */
export class DabSpacer {
  readonly #settings: BrushSettings;
  readonly #sizeScale: ((placed: PlacedDab) => number) | null;
  #last: StrokePoint | null = null;
  /** Distance to go before the next dab. */
  #remaining = 0;
  #index = 0;
  #direction = 0;
  #initialDirection: number | null = null;
  /** Build-up: milliseconds between dabs while the pointer stays put (0: off). */
  readonly #interval: number;
  /** Time of the last dab (ms since the stroke began). */
  #lastTime = 0;

  /**
   * `sizeScale`: how much dynamics will shrink or grow a dab, so the next one is spaced by its real size.
   * `interval`: with Build-up, a dab at least this often (ms), even without moving.
   */
  constructor(settings: BrushSettings, sizeScale: ((placed: PlacedDab) => number) | null = null, interval = 0) {
    this.#settings = settings;
    this.#sizeScale = sizeScale;
    this.#interval = interval;
  }

  #dab(p: StrokePoint): Dab {
    const s = this.#settings;
    return {
      x: p.x,
      y: p.y,
      size: Math.max(1, s.pressureSize ? s.size * p.pressure : s.size),
      strength: s.pressureOpacity ? p.pressure : 1,
      angle: s.angle,
      roundness: s.roundness,
      flipX: s.flipX,
      flipY: s.flipY,
    };
  }

  /** Adds a pointer sample; returns the dabs it produces (the first sample always makes one). */
  add(p: StrokePoint): Dab[] {
    return this.place(p).map((d) => d.dab);
  }

  #placed(dab: Dab, point: StrokePoint): PlacedDab {
    return {
      dab,
      point,
      index: this.#index++,
      direction: this.#direction,
      initialDirection: this.#initialDirection ?? this.#direction,
    };
  }

  /** Like `add`, with what dynamics need for each dab. */
  place(p: StrokePoint): PlacedDab[] {
    const last = this.#last;
    this.#last = p;
    if (!last) {
      const first = this.#placed(this.#dab(p), p);
      this.#remaining = this.#step(first);
      this.#lastTime = p.time;
      return [first];
    }
    const dabs: PlacedDab[] = [];
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    const length = Math.hypot(dx, dy);
    if (length > 0) {
      this.#direction = Math.atan2(dy, dx);
      this.#initialDirection ??= this.#direction;
    }
    let travelled = 0;
    while (length - travelled >= this.#remaining) {
      travelled += this.#remaining;
      const t = travelled / length;
      const mix = (a: number, b: number) => a + (b - a) * t;
      const point: StrokePoint = {
        x: last.x + dx * t,
        y: last.y + dy * t,
        pressure: mix(last.pressure, p.pressure),
        tiltX: mix(last.tiltX, p.tiltX),
        tiltY: mix(last.tiltY, p.tiltY),
        twist: mix(last.twist, p.twist),
        wheel: mix(last.wheel, p.wheel),
        time: mix(last.time, p.time),
      };
      const placed = this.#placed(this.#dab(point), point);
      dabs.push(placed);
      this.#remaining = this.#step(placed);
      this.#lastTime = point.time;
    }
    this.#remaining -= length - travelled;
    if (this.#interval > 0) {
      // Build-up: paint keeps coming where the pointer is (at most a second's worth at once).
      let n = 0;
      while (p.time - this.#lastTime >= this.#interval && n < 30) {
        this.#lastTime += this.#interval;
        dabs.push(this.#placed(this.#dab(p), p));
        n++;
      }
      if (n === 30) this.#lastTime = p.time;
    }
    return dabs;
  }

  /** Distance to the dab after `placed`: Spacing × its diameter. */
  #step(placed: PlacedDab): number {
    const size = Math.max(1, placed.dab.size * (this.#sizeScale?.(placed) ?? 1));
    return Math.max(0.5, this.#settings.spacing * size);
  }
}

/** Next brush size for [ (−1) or ] (+1): steps grow with the size. */
export function stepBrushSize(size: number, direction: 1 | -1): number {
  const step = size < 10 ? 1 : size < 50 ? 5 : size < 100 ? 10 : size < 200 ? 25 : size < 300 ? 50 : 100;
  const down = size <= 10 ? 1 : size <= 50 ? 5 : size <= 100 ? 10 : size <= 200 ? 25 : size <= 300 ? 50 : 100;
  const next = direction > 0 ? Math.floor(size / step) * step + step : Math.ceil(size / down) * down - down;
  return Math.min(5000, Math.max(1, next));
}

/** Next hardness for Shift+[ (−1) / Shift+] (+1), in 25 % steps. */
export function stepHardness(hardness: number, direction: 1 | -1): number {
  const q = Math.round(hardness * 4);
  return Math.min(4, Math.max(0, q + direction)) / 4;
}

/**
 * Where a dab's pixel offset (dx, dy from the centre, document px) lies in the tip's
 * own frame: angle undone (counter-clockwise on screen, y down), flips applied.
 */
export function toTipFrame(d: Dab, dx: number, dy: number): [number, number] {
  const a = (d.angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  let u = dx * c - dy * s;
  let v = dx * s + dy * c;
  if (d.flipX) u = -u;
  if (d.flipY) v = -v;
  return [u, v];
}

/** The pixel area a dab touches (document px, whole pixels); sampled tips may reach their half-diagonal. */
export function dabBounds(d: Dab, sampled = false): { x: number; y: number; w: number; h: number } {
  const r = (d.size / 2) * (sampled ? Math.SQRT2 : 1) + 1;
  const x0 = Math.floor(d.x - r);
  const y0 = Math.floor(d.y - r);
  return { x: x0, y: y0, w: Math.ceil(d.x + r) - x0, h: Math.ceil(d.y + r) - y0 };
}
