/**
 * The Art History Brush's strokes (our own design; the reference app only describes
 * what the options do, not how its strokes are made).
 *
 * As the pointer moves (and while it rests), each burst starts a few short strokes at
 * random points within Area around it. A stroke takes one colour — the source state's
 * at its start — and runs along the source image: the "tight" styles follow its edges
 * (across the brightness gradient) closely, the "loose" ones wander, the "curl" styles
 * turn steadily, and Dab is a single dab. Tolerance keeps strokes to where the layer
 * (as it was when the stroke began) differs from the source by at least that much.
 *
 * The strokes are painted with the brush (tip, spacing and dynamics), each with its own
 * colour. Everything follows from the pointer samples, the seed, the source state and
 * the layer before the stroke, so a recorded stroke replays the same.
 */
import { seededRandom } from '../random';
import type { BrushSettings, Dab, StrokePoint } from './brush';
import { StrokeDabber } from './dynamics';

export type ArtHistoryStyle =
  | 'tight-short'
  | 'tight-medium'
  | 'tight-long'
  | 'loose-medium'
  | 'loose-long'
  | 'dab'
  | 'tight-curl'
  | 'tight-curl-long'
  | 'loose-curl'
  | 'loose-curl-long';

/** The styles, in menu order, with their labels. */
export const ART_HISTORY_STYLES: readonly (readonly [ArtHistoryStyle, string])[] = [
  ['tight-short', 'Tight Short'],
  ['tight-medium', 'Tight Medium'],
  ['tight-long', 'Tight Long'],
  ['loose-medium', 'Loose Medium'],
  ['loose-long', 'Loose Long'],
  ['dab', 'Dab'],
  ['tight-curl', 'Tight Curl'],
  ['tight-curl-long', 'Tight Curl Long'],
  ['loose-curl', 'Loose Curl'],
  ['loose-curl-long', 'Loose Curl Long'],
];

export interface ArtHistoryOptions {
  style: ArtHistoryStyle;
  /** Diameter of the area strokes start in, document px (0–500). */
  area: number;
  /** 0–1: strokes start only where the layer differs from the source at least this much. */
  tolerance: number;
}

export const DEFAULT_ART_HISTORY: Readonly<ArtHistoryOptions> = Object.freeze({
  style: 'tight-short',
  area: 50,
  tolerance: 0,
});

/** How a style's strokes run: length in brush diameters, how much they turn along edges, wobble and curl (°/step). */
const STYLES: Record<ArtHistoryStyle, { length: number; follow: number; wobble: number; curl: number }> = {
  'tight-short': { length: 1.5, follow: 0.8, wobble: 4, curl: 0 },
  'tight-medium': { length: 3, follow: 0.8, wobble: 4, curl: 0 },
  'tight-long': { length: 6, follow: 0.8, wobble: 4, curl: 0 },
  'loose-medium': { length: 3, follow: 0.35, wobble: 22, curl: 0 },
  'loose-long': { length: 6, follow: 0.35, wobble: 22, curl: 0 },
  dab: { length: 0, follow: 0, wobble: 0, curl: 0 },
  'tight-curl': { length: 3, follow: 0, wobble: 3, curl: 40 },
  'tight-curl-long': { length: 6, follow: 0, wobble: 3, curl: 40 },
  'loose-curl': { length: 4, follow: 0, wobble: 12, curl: 20 },
  'loose-curl-long': { length: 8, follow: 0, wobble: 12, curl: 20 },
};

/** While the pointer rests, a burst this often (ms of stroke time). */
const BURST_MS = 50;
/** Roughly how much of the area one burst covers. */
const BURST_COVERAGE = 0.3;
const MAX_STROKES_PER_BURST = 30;
/** Weaker brightness gradients (0–1 per sample distance) count as no edge. */
const EDGE_THRESHOLD = 0.02;

/** Reads pixels: colour samples into `out`, returns alpha 0–1. */
export type PixelReader = (x: number, y: number, out: number[]) => number;

export interface ArtHistorySampler {
  /** The source state's version of the layer. */
  source: PixelReader;
  /** The layer as it was when the stroke began. */
  layer: PixelReader;
  /** Colour channels, and the highest sample value (255, 65535; 1 for 32-bit). */
  channels: number;
  max: number;
}

/** A reader of a layer's pixels at document points (integer pixel positions). */
export function layerReader(
  layer: {
    buffer: {
      getPixel(x: number, y: number, out?: number[]): number[];
      format: { colorChannels: number; hasAlpha: boolean };
    };
    offsetX: number;
    offsetY: number;
  },
  max: number,
): PixelReader {
  const { colorChannels: cc, hasAlpha } = layer.buffer.format;
  const px: number[] = [];
  return (x, y, out) => {
    layer.buffer.getPixel(Math.floor(x) - layer.offsetX, Math.floor(y) - layer.offsetY, px);
    for (let c = 0; c < cc; c++) out[c] = px[c]!;
    return hasAlpha ? px[cc]! / max : 1;
  };
}

export class ArtHistoryDabber {
  readonly #brush: BrushSettings;
  readonly #options: ArtHistoryOptions;
  readonly #sampler: ArtHistorySampler;
  readonly #random: () => number;
  #last: { x: number; y: number; time: number } | null = null;
  readonly #scratch: number[] = [];
  readonly #scratch2: number[] = [];

  constructor(brush: BrushSettings, options: ArtHistoryOptions, seed: number, sampler: ArtHistorySampler) {
    // The strokes' own dabs: no build-up of their own.
    this.#brush = brush.dynamics ? { ...brush, dynamics: { ...brush.dynamics, buildUp: false } } : brush;
    this.#options = options;
    this.#sampler = sampler;
    this.#random = seededRandom(seed >>> 0);
  }

  /** The dabs a pointer sample adds: a burst once the pointer has moved a little, or rested a while. */
  add(p: StrokePoint): Dab[] {
    const last = this.#last;
    const step = Math.max(2, this.#brush.size / 2);
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < step && p.time - last.time < BURST_MS) return [];
    this.#last = { x: p.x, y: p.y, time: p.time };
    return this.#burst(p);
  }

  #burst(p: StrokePoint): Dab[] {
    const size = Math.max(1, this.#brush.size);
    const style = STYLES[this.#options.style];
    const length = style.length * size;
    const radius = this.#options.area / 2;
    const count = Math.min(
      MAX_STROKES_PER_BURST,
      Math.max(1, Math.ceil((BURST_COVERAGE * Math.PI * radius * radius) / (size * Math.max(size, length)))),
    );
    const random = this.#random;
    const out: Dab[] = [];
    for (let n = 0; n < count; n++) {
      // A uniform point in the area, and the stroke's own seed — drawn even when the stroke is skipped.
      const r = radius * Math.sqrt(random());
      const a = random() * 2 * Math.PI;
      const seed = Math.floor(random() * 2 ** 31);
      const x = p.x + r * Math.cos(a);
      const y = p.y + r * Math.sin(a);
      const color = this.#strokeColor(x, y);
      if (!color) continue;
      const path = this.#path(x, y, length, style, seedRandom(seed));
      const dabber = new StrokeDabber(this.#brush, seed, null, null);
      for (const q of path) {
        for (const dab of dabber.add({ ...p, x: q.x, y: q.y, time: 0 })) {
          if (!dab.dual) dab.color = color;
          out.push(dab);
        }
      }
    }
    return out;
  }

  /** The source colour a stroke starting here paints, or null where it does not start (transparent, or within Tolerance). */
  #strokeColor(x: number, y: number): number[] | null {
    const s = this.#sampler;
    const color = new Array<number>(s.channels);
    const as = s.source(x, y, color);
    if (as <= 0) return null;
    const tolerance = this.#options.tolerance;
    if (tolerance > 0) {
      const now = this.#scratch;
      const al = s.layer(x, y, now);
      let diff = Math.abs(as - al);
      for (let c = 0; c < s.channels; c++) diff = Math.max(diff, Math.abs(color[c]! * as - now[c]! * al) / s.max);
      if (diff < tolerance) return null;
    }
    return color;
  }

  /** The stroke's path from (x, y): points about a quarter of the brush apart. */
  #path(
    x: number,
    y: number,
    length: number,
    style: (typeof STYLES)[ArtHistoryStyle],
    random: () => number,
  ): { x: number; y: number }[] {
    const points = [{ x, y }];
    if (length <= 0) return points;
    const step = Math.max(1, this.#brush.size / 4);
    const steps = Math.ceil(length / step);
    const edge = this.#edge(x, y);
    let heading = (edge ?? random() * 2 * Math.PI) + (random() < 0.5 ? Math.PI : 0);
    const curl = ((style.curl * Math.PI) / 180) * (random() < 0.5 ? -1 : 1);
    const wobble = (style.wobble * Math.PI) / 180;
    for (let i = 0; i < steps; i++) {
      if (style.follow > 0) {
        const e = this.#edge(x, y);
        if (e !== null) {
          // The edge's way that is closer to where the stroke is going.
          let d = angleDiff(e, heading);
          if (Math.abs(d) > Math.PI / 2) d = angleDiff(e + Math.PI, heading);
          heading += style.follow * d;
        }
      }
      heading += curl + (random() * 2 - 1) * wobble;
      x += step * Math.cos(heading);
      y += step * Math.sin(heading);
      points.push({ x, y });
    }
    return points;
  }

  /** The direction along the source's edge at a point (across its brightness gradient), or null on flat areas. */
  #edge(x: number, y: number): number | null {
    const d = Math.max(1, Math.round(this.#brush.size / 4));
    const gx = this.#brightness(x + d, y) - this.#brightness(x - d, y);
    const gy = this.#brightness(x, y + d) - this.#brightness(x, y - d);
    if (Math.hypot(gx, gy) < EDGE_THRESHOLD) return null;
    return Math.atan2(gy, gx) + Math.PI / 2;
  }

  /** The source's brightness 0–1 (over black where transparent). */
  #brightness(x: number, y: number): number {
    const s = this.#sampler;
    const c = this.#scratch2;
    const a = s.source(x, y, c);
    const v = s.channels === 3 ? 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]! : average(c, s.channels);
    return (v / s.max) * a;
  }
}

function average(values: readonly number[], n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i]!;
  return sum / n;
}

/** a − b, wrapped to −π…π. */
function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

const seedRandom = (seed: number) => seededRandom((seed ^ 0x2545f491) >>> 0);
