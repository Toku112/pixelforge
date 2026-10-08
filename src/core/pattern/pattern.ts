/**
 * Patterns: small images that repeat edge to edge (brush Texture now; Edit > Fill,
 * the Pattern Stamp and pattern layers later).
 *
 * The built-in set is ours, drawn by code (CLAUDE.md §1.1: no bundled presets from
 * elsewhere): seeded, so every copy of the app has exactly the same pixels, and
 * tileable, so the repeats never show a seam.
 */
import { seededRandom } from '../random';

export interface Pattern {
  id: string;
  name: string;
  width: number;
  height: number;
  /** RGBA, 8 bits per sample, row by row. */
  data: Uint8Array;
}

/** Where patterns are found by id (the app's pattern library). */
export interface PatternSource {
  get(id: string): Pattern | undefined;
}

/** A gray pattern from values 0–1 (one per pixel). */
function grayPattern(id: string, name: string, w: number, h: number, value: (x: number, y: number) => number): Pattern {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.round(255 * Math.min(1, Math.max(0, value(x, y))));
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  return { id, name, width: w, height: h, data };
}

/** Tileable value noise: random values on a `cells` × `cells` lattice that wraps, smoothly interpolated. */
function valueNoise(size: number, cells: number, seed: number): (x: number, y: number) => number {
  const random = seededRandom(seed);
  const lattice = Float32Array.from({ length: cells * cells }, () => random());
  const at = (i: number, j: number) =>
    lattice[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)]!;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const u = (x / size) * cells;
    const v = (y / size) * cells;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fx = smooth(u - i);
    const fy = smooth(v - j);
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
    return top + (bottom - top) * fy;
  };
}

/** Octaves of value noise, normalised to 0–1 over the tile. */
function fractal(size: number, octaves: [cells: number, weight: number][], seed: number) {
  const layers = octaves.map(([cells, weight], k) => ({ noise: valueNoise(size, cells, seed + k * 101), weight }));
  const raw = new Float32Array(size * size);
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const l of layers) v += l.noise(x, y) * l.weight;
      raw[y * size + x] = v;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  return (x: number, y: number) => (raw[y * size + x]! - lo) / (hi - lo || 1);
}

const BUILT_IN: readonly { id: string; name: string; make: () => Pattern }[] = [
  {
    id: 'pf-paper',
    name: 'Paper',
    make: () => {
      const f = fractal(
        128,
        [
          [8, 0.5],
          [16, 0.3],
          [64, 0.2],
        ],
        11,
      );
      return grayPattern('pf-paper', 'Paper', 128, 128, (x, y) => 0.25 + 0.75 * f(x, y));
    },
  },
  {
    id: 'pf-rough-paper',
    name: 'Rough Paper',
    make: () => {
      const f = fractal(
        256,
        [
          [4, 0.35],
          [16, 0.3],
          [64, 0.2],
          [128, 0.15],
        ],
        23,
      );
      return grayPattern('pf-rough-paper', 'Rough Paper', 256, 256, (x, y) => f(x, y) ** 0.8);
    },
  },
  {
    id: 'pf-canvas',
    name: 'Canvas',
    make: () => {
      // Threads 8 px apart, going over and under each other in a plain weave.
      const grain = fractal(64, [[32, 1]], 37);
      return grayPattern('pf-canvas', 'Canvas', 64, 64, (x, y) => {
        const across = Math.sin(((y % 8) / 8) * Math.PI);
        const down = Math.sin(((x % 8) / 8) * Math.PI);
        const over = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
        const thread = over ? across : down;
        return 0.2 + 0.7 * thread + 0.1 * grain(x, y);
      });
    },
  },
  {
    id: 'pf-grain',
    name: 'Grain',
    make: () => {
      const size = 128;
      const random = seededRandom(53);
      const white = Float32Array.from({ length: size * size }, () => random());
      const at = (x: number, y: number) => white[((y + size) % size) * size + ((x + size) % size)]!;
      // Softened by a 3 × 3 average, then stretched back to full contrast.
      return grayPattern('pf-grain', 'Grain', size, size, (x, y) => {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += at(x + dx, y + dy);
        return 0.5 + (sum / 9 - 0.5) * 3;
      });
    },
  },
  {
    id: 'pf-hatching',
    name: 'Hatching',
    make: () =>
      grayPattern('pf-hatching', 'Hatching', 32, 32, (x, y) => {
        // Dark diagonal lines 2 px wide every 8 px (32 is a multiple, so it tiles).
        const d = (x + y) % 8;
        return Math.min(1, Math.max(0, (Math.abs(d - 3.5) - 0.5) / 1.5));
      }),
  },
  {
    id: 'pf-dots',
    name: 'Dots',
    make: () =>
      grayPattern('pf-dots', 'Dots', 16, 16, (x, y) => {
        const r = Math.hypot(x + 0.5 - 8, y + 0.5 - 8);
        return Math.min(1, Math.max(0, (r - 3.5) / 1.5));
      }),
  },
];

const made = new Map<string, Pattern>();

/** A built-in pattern by id (made on first use). */
export function builtInPattern(id: string): Pattern | undefined {
  const known = made.get(id);
  if (known) return known;
  const def = BUILT_IN.find((p) => p.id === id);
  if (!def) return undefined;
  const pattern = def.make();
  made.set(id, pattern);
  return pattern;
}

/** All built-in patterns, in their order in the picker. */
export function builtInPatterns(): Pattern[] {
  return BUILT_IN.map((p) => builtInPattern(p.id)!);
}

export const DEFAULT_PATTERN_ID = 'pf-paper';

/** The pattern as gray levels 0–255 (luminance, transparent parts counting as white). */
export function patternGray(p: Pattern): Uint8Array {
  const out = new Uint8Array(p.width * p.height);
  for (let i = 0; i < out.length; i++) {
    const r = p.data[i * 4]!;
    const g = p.data[i * 4 + 1]!;
    const b = p.data[i * 4 + 2]!;
    const a = p.data[i * 4 + 3]! / 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    out[i] = Math.round(255 - a * (255 - lum));
  }
  return out;
}
