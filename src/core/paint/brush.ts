/**
 * Round brush maths: the dab profile, placing dabs along a stroke, and the size and
 * hardness steps of the [ ] { } keys.
 *
 * Behaviour (own summary of the reference app):
 * - A stroke is a series of round dabs, `spacing` × diameter apart along the path.
 * - Hardness is the share of the radius that is fully solid; the rest fades out
 *   smoothly to the edge. At 100 % the edge is a single anti-aliased pixel.
 * - Pen pressure can scale the size and/or the opacity of each dab (options bar).
 * - [ and ] change the size in steps that grow with the size; Shift+[ / ] change
 *   the hardness by 25 %.
 */

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
}

export const DEFAULT_BRUSH: Readonly<BrushSettings> = Object.freeze({
  size: 30,
  hardness: 1,
  opacity: 1,
  flow: 1,
  spacing: 0.25,
  pressureSize: false,
  pressureOpacity: false,
});

/** One dab: centre (document px), diameter (px) and strength (0–1, multiplies flow). */
export interface Dab {
  x: number;
  y: number;
  size: number;
  strength: number;
}

/** A pointer sample of a stroke (document px; pressure 0–1, 1 for a mouse). */
export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
}

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
  #last: StrokePoint | null = null;
  /** Distance to go before the next dab. */
  #remaining = 0;

  constructor(settings: BrushSettings) {
    this.#settings = settings;
  }

  #dab(p: StrokePoint): Dab {
    const s = this.#settings;
    return {
      x: p.x,
      y: p.y,
      size: Math.max(1, s.pressureSize ? s.size * p.pressure : s.size),
      strength: s.pressureOpacity ? p.pressure : 1,
    };
  }

  /** Adds a pointer sample; returns the dabs it produces (the first sample always makes one). */
  add(p: StrokePoint): Dab[] {
    const last = this.#last;
    this.#last = p;
    if (!last) {
      this.#remaining = this.#step(this.#dab(p).size);
      return [this.#dab(p)];
    }
    const dabs: Dab[] = [];
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    const length = Math.hypot(dx, dy);
    let travelled = 0;
    while (length - travelled >= this.#remaining) {
      travelled += this.#remaining;
      const t = travelled / length;
      const point = {
        x: last.x + dx * t,
        y: last.y + dy * t,
        pressure: last.pressure + (p.pressure - last.pressure) * t,
      };
      const dab = this.#dab(point);
      dabs.push(dab);
      this.#remaining = this.#step(dab.size);
    }
    this.#remaining -= length - travelled;
    return dabs;
  }

  #step(size: number): number {
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

/** The pixel area a dab touches (document px, whole pixels). */
export function dabBounds(d: Dab): { x: number; y: number; w: number; h: number } {
  const r = d.size / 2 + 1;
  const x0 = Math.floor(d.x - r);
  const y0 = Math.floor(d.y - r);
  return { x: x0, y: y0, w: Math.ceil(d.x + r) - x0, h: Math.ceil(d.y + r) - y0 };
}
