/**
 * Stroke smoothing: the paint follows the pointer on a "string", so hand jitter
 * never reaches the canvas.
 *
 * Behaviour (own summary of the reference app):
 * - Smoothing 0–100 % sets how long the string is and how lazily the paint follows.
 * - Pulled String Mode: the paint moves only while the string is taut; moving the
 *   pointer within the string's reach leaves no mark.
 * - Stroke Catch-up: while the pointer rests, the paint keeps drifting to it (off:
 *   painting stops as soon as the pointer stops).
 * - Catch-up on Stroke End: releasing finishes the stroke at the pointer.
 * - Adjust for Zoom: the string keeps its length on screen (shorter in the image
 *   when zoomed in, longer when zoomed out).
 * - Separately, the brush's Smoothing setting (Brush Settings) draws curves through
 *   the pointer samples instead of straight lines between them.
 *
 * The smoothed points are what a stroke records, so replaying it paints the same.
 */
import type { StrokePoint } from './brush';

export interface SmoothingOptions {
  /** 0–1. */
  amount: number;
  pulledString: boolean;
  catchUp: boolean;
  catchUpOnEnd: boolean;
  adjustForZoom: boolean;
  /** Curves through the samples (the brush's Smoothing setting). */
  curves: boolean;
}

export const DEFAULT_SMOOTHING: Readonly<SmoothingOptions> = Object.freeze({
  amount: 0.1,
  pulledString: false,
  catchUp: true,
  catchUpOnEnd: false,
  adjustForZoom: true,
  curves: true,
});

/** The string's length at 100 %, CSS pixels on screen (Adjust for Zoom) or image pixels. */
export const SMOOTHING_RADIUS = 60;
/** How lazily the paint drifts to the pointer at 100 % (exponential time constant, ms). */
export const SMOOTHING_TIME = 150;

/** The string's length in image pixels for a view (`zoom`: device px per image px). */
export function smoothingRadius(o: SmoothingOptions, zoom: number, devicePixelRatio: number): number {
  const length = o.amount * SMOOTHING_RADIUS;
  return o.adjustForZoom ? (length * devicePixelRatio) / zoom : length;
}

const MOVED = 0.05; // image px: smaller moves paint nothing new

/** Turns pointer samples into the points the paint goes through. */
export class StrokeSmoother {
  readonly #o: SmoothingOptions;
  readonly #radius: number;
  readonly #tau: number;
  #paint: StrokePoint | null = null;
  #pointer: StrokePoint | null = null;
  #time = 0;

  /** `radius`: the string's length in image pixels (see smoothingRadius). */
  constructor(options: SmoothingOptions, radius: number) {
    this.#o = options;
    this.#radius = options.amount > 0 ? radius : 0;
    this.#tau = options.amount * SMOOTHING_TIME;
  }

  /** Where the paint is (null before the first sample). */
  get paint(): StrokePoint | null {
    return this.#paint;
  }

  /** The string's length, image pixels. */
  get radius(): number {
    return this.#radius;
  }

  get active(): boolean {
    return this.#o.amount > 0;
  }

  /** A pointer sample; returns where the paint went (nothing when it stayed). */
  add(sample: StrokePoint): StrokePoint[] {
    this.#pointer = sample;
    const paint = this.#paint;
    if (!paint || !this.active) {
      this.#paint = sample;
      this.#time = sample.time;
      return [sample];
    }
    let x = paint.x;
    let y = paint.y;
    // The string pulls the paint once the pointer is farther than its length.
    const d = Math.hypot(sample.x - x, sample.y - y);
    if (d > this.#radius) {
      x = sample.x - ((sample.x - x) * this.#radius) / d;
      y = sample.y - ((sample.y - y) * this.#radius) / d;
    }
    return this.#move(x, y, sample, sample.time);
  }

  /** Time passing with the pointer at rest: with Stroke Catch-up the paint drifts on. */
  tick(time: number): StrokePoint[] {
    const paint = this.#paint;
    const pointer = this.#pointer;
    if (!paint || !pointer || !this.active || !this.#o.catchUp || this.#o.pulledString || time <= this.#time) return [];
    return this.#move(paint.x, paint.y, { ...pointer, time }, time);
  }

  /** The pointer was released: with Catch-up on Stroke End the paint goes the rest of the way. */
  end(): StrokePoint[] {
    const paint = this.#paint;
    const pointer = this.#pointer;
    if (!paint || !pointer || !this.active || !this.#o.catchUpOnEnd) return [];
    if (Math.hypot(pointer.x - paint.x, pointer.y - paint.y) < MOVED) return [];
    this.#paint = pointer;
    return [pointer];
  }

  /** Drifts (unless Pulled String) from (x, y) towards the pointer and records the new paint point. */
  #move(x: number, y: number, sample: StrokePoint, time: number): StrokePoint[] {
    const paint = this.#paint!;
    const dt = Math.max(0, time - this.#time);
    this.#time = time;
    if (!this.#o.pulledString && this.#tau > 0) {
      const f = 1 - Math.exp(-dt / this.#tau);
      x += (sample.x - x) * f;
      y += (sample.y - y) * f;
    }
    if (Math.hypot(x - paint.x, y - paint.y) < MOVED) return [];
    // The pen's other values are the pointer's now.
    const next = { ...sample, x, y, time };
    this.#paint = next;
    return [next];
  }
}

/**
 * Curves through the points (Catmull-Rom): each segment is drawn once the point after it
 * is known, so it lags one point behind; `flush` draws the last one.
 */
export class CurveSmoother {
  readonly #points: StrokePoint[] = [];

  push(p: StrokePoint): StrokePoint[] {
    const pts = this.#points;
    pts.push(p);
    if (pts.length === 1) return [p];
    if (pts.length < 3) return [];
    // Segment pts[n−3]→pts[n−2] with neighbours (the first point repeats as its own neighbour).
    const n = pts.length;
    const out = this.#segment(pts[n - 4] ?? pts[n - 3]!, pts[n - 3]!, pts[n - 2]!, pts[n - 1]!);
    if (pts.length > 4) pts.shift();
    return out;
  }

  /** The last segment (towards the final point). */
  flush(): StrokePoint[] {
    const pts = this.#points;
    const n = pts.length;
    if (n < 2) return [];
    const out = this.#segment(pts[n - 3] ?? pts[n - 2]!, pts[n - 2]!, pts[n - 1]!, pts[n - 1]!);
    pts.length = 0;
    return out;
  }

  /** Points along the curve from p1 to p2 (p1 excluded, p2 included), about every 2 image px. */
  #segment(p0: StrokePoint, p1: StrokePoint, p2: StrokePoint, p3: StrokePoint): StrokePoint[] {
    const steps = Math.min(16, Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2)));
    const out: StrokePoint[] = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      const mix = (a: number, b: number) => a + (b - a) * t;
      out.push({
        x: cr(p0.x, p1.x, p2.x, p3.x),
        y: cr(p0.y, p1.y, p2.y, p3.y),
        pressure: mix(p1.pressure, p2.pressure),
        tiltX: mix(p1.tiltX, p2.tiltX),
        tiltY: mix(p1.tiltY, p2.tiltY),
        twist: mix(p1.twist, p2.twist),
        wheel: mix(p1.wheel, p2.wheel),
        time: mix(p1.time, p2.time),
      });
    }
    return out;
  }
}
