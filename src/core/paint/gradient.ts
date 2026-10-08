/**
 * Gradients: their definition (colour and opacity stops with midpoints, or noise), how
 * colours are interpolated, and the shapes they are laid out in.
 *
 * Behaviour (own summary of the reference app):
 * - A solid gradient has colour stops (a colour, the foreground or the background)
 *   and opacity stops along it; between two stops the midpoint marks where the two
 *   are mixed half and half. Smoothness (0–100 %) rounds off the transitions at the
 *   stops instead of joining them with straight lines.
 * - Method (an option of the tool): Perceptual (mixes as the eye sees), Linear (mixes
 *   light), Classic (mixes the stored values, as older versions did), Smooth (eases
 *   in and out of every stop) and Stripes (no mixing: hard steps).
 * - A noise gradient is random colours within ranges per channel (RGB, HSB or Lab),
 *   rougher or smoother, optionally with restricted colours and random transparency.
 * - Shapes: linear, radial, angle (sweeping counter-clockwise round the start point),
 *   reflected (linear both ways) and diamond (the end point is a corner), from where
 *   the drag starts to where it ends. Reverse flips it; Dither breaks up banding;
 *   without Transparency the opacity stops are ignored.
 *
 * The exact curves are ours (FORMAT_NOTES §11, DECISIONS D-045): smoothness blends
 * straight lines with a Catmull-Rom spline through the stops; Perceptual mixes in
 * Oklab.
 */
import { hsbToRgb, labToRgb, rgbToHsb, type RGB } from '../color/color';
import type { BitDepth, ColorMode } from '../document/pixel-format';
import { linearToSrgb, srgbToLinear } from '../color/srgb';
import { seededRandom } from '../random';

export type GradientMethod = 'perceptual' | 'linear' | 'classic' | 'smooth' | 'stripes';
export const GRADIENT_METHODS: readonly [GradientMethod, string][] = [
  ['perceptual', 'Perceptual'],
  ['linear', 'Linear'],
  ['classic', 'Classic'],
  ['smooth', 'Smooth'],
  ['stripes', 'Stripes'],
];

export type GradientShape = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
export const GRADIENT_SHAPES: readonly [GradientShape, string][] = [
  ['linear', 'Linear Gradient'],
  ['radial', 'Radial Gradient'],
  ['angle', 'Angle Gradient'],
  ['reflected', 'Reflected Gradient'],
  ['diamond', 'Diamond Gradient'],
];

/** A colour stop: a colour, or the foreground / background colour at the time of use. */
export interface ColorStop {
  /** 0–1 along the gradient. */
  location: number;
  /** Where between this stop and the next the two mix half and half (0.05–0.95; 0.5 = halfway). */
  midpoint: number;
  color: RGB;
  kind: 'color' | 'foreground' | 'background';
}

export interface OpacityStop {
  location: number;
  midpoint: number;
  /** 0–1. */
  opacity: number;
}

export interface SolidGradient {
  type: 'solid';
  name: string;
  colorStops: ColorStop[];
  opacityStops: OpacityStop[];
  /** 0–1: rounds off the transitions at the stops. */
  smoothness: number;
}

export type NoiseModel = 'rgb' | 'hsb' | 'lab';

export interface NoiseGradient {
  type: 'noise';
  name: string;
  /** 0–1: how often the colours change. */
  roughness: number;
  model: NoiseModel;
  /** Per channel of the model, 0–1. */
  min: [number, number, number];
  max: [number, number, number];
  restrictColors: boolean;
  addTransparency: boolean;
  seed: number;
}

export type Gradient = SolidGradient | NoiseGradient;

const BLACK: RGB = { r: 0, g: 0, b: 0 };
const WHITE: RGB = { r: 1, g: 1, b: 1 };
const OPAQUE: OpacityStop[] = [
  { location: 0, midpoint: 0.5, opacity: 1 },
  { location: 1, midpoint: 0.5, opacity: 1 },
];

/** A solid gradient from colour stops (opaque throughout unless opacity stops are given). */
export function solidGradient(
  name: string,
  stops: (Omit<ColorStop, 'midpoint' | 'kind'> & Partial<Pick<ColorStop, 'midpoint' | 'kind'>>)[],
  opacityStops: OpacityStop[] = OPAQUE,
): SolidGradient {
  return {
    type: 'solid',
    name,
    colorStops: stops.map((s) => ({ midpoint: 0.5, kind: 'color', ...s })),
    opacityStops: opacityStops.map((s) => ({ ...s })),
    smoothness: 1,
  };
}

/** A new noise gradient with the reference app's defaults (half rough, full RGB ranges). */
export function noiseGradient(name: string, seed: number): NoiseGradient {
  return {
    type: 'noise',
    name,
    roughness: 0.5,
    model: 'rgb',
    min: [0, 0, 0],
    max: [1, 1, 1],
    restrictColors: false,
    addTransparency: false,
    seed,
  };
}

/** The first preset: foreground to background. */
export const FOREGROUND_TO_BACKGROUND: SolidGradient = solidGradient('Foreground to Background', [
  { location: 0, color: BLACK, kind: 'foreground' },
  { location: 1, color: WHITE, kind: 'background' },
]);

/** The gradient with its foreground/background stops given those colours. */
export function resolveGradient(g: Gradient, foreground: RGB, background: RGB): Gradient {
  if (g.type !== 'solid') return g;
  return {
    ...g,
    colorStops: g.colorStops.map((s) =>
      s.kind === 'foreground'
        ? { ...s, color: { ...foreground } }
        : s.kind === 'background'
          ? { ...s, color: { ...background } }
          : s,
    ),
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (t: number) => t * t * (3 - 2 * t);

/** Between two stops: `u` (0–1) bent so the midpoint maps to 0.5. */
function warp(u: number, midpoint: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const m = Math.min(0.95, Math.max(0.05, midpoint));
  return m === 0.5 ? u : Math.pow(u, Math.log(0.5) / Math.log(m));
}

/**
 * Values (vectors) given at stops, evaluated anywhere along the gradient: joined by
 * straight lines, rounded off by a spline as far as `smoothness` says (Smooth: eased
 * at every stop; Stripes: a hard step at each midpoint).
 */
class StopCurve {
  readonly #locations: number[];
  readonly #midpoints: number[];
  readonly #values: number[][];
  /** Slopes at each stop (per unit of location), for the spline. */
  readonly #slopes: number[][];
  readonly #method: GradientMethod;
  readonly #smoothness: number;

  constructor(
    stops: readonly { location: number; midpoint: number }[],
    values: number[][],
    method: GradientMethod,
    smoothness: number,
  ) {
    this.#locations = stops.map((s) => s.location);
    this.#midpoints = stops.map((s) => s.midpoint);
    this.#values = values;
    this.#method = method;
    this.#smoothness = clamp01(smoothness);
    const n = values.length;
    const loc = this.#locations;
    this.#slopes = values.map((v, i) =>
      v.map((_, c) => {
        if (n < 2) return 0;
        if (i === 0 || i === n - 1) {
          // Ends: half the slope of the end segment (Catmull-Rom with the end repeated).
          const [a, b] = i === 0 ? [0, 1] : [n - 2, n - 1];
          const span = loc[b]! - loc[a]!;
          return span > 0 ? (0.5 * (values[b]![c]! - values[a]![c]!)) / span : 0;
        }
        const span = loc[i + 1]! - loc[i - 1]!;
        return span > 0 ? (values[i + 1]![c]! - values[i - 1]![c]!) / span : 0;
      }),
    );
  }

  at(t: number, out: number[]): void {
    const loc = this.#locations;
    const n = loc.length;
    const values = this.#values;
    const set = (v: readonly number[]) => {
      for (let c = 0; c < v.length; c++) out[c] = v[c]!;
    };
    if (t <= loc[0]!) return set(values[0]!);
    if (t >= loc[n - 1]!) return set(values[n - 1]!);
    let i = 0;
    while (i < n - 2 && t > loc[i + 1]!) i++;
    const span = loc[i + 1]! - loc[i]!;
    if (span <= 0) return set(values[i + 1]!);
    const u = warp((t - loc[i]!) / span, this.#midpoints[i]!);
    const a = values[i]!;
    const b = values[i + 1]!;
    if (this.#method === 'stripes') return set(u < 0.5 ? a : b);
    if (this.#method === 'smooth') {
      const e = ease(u);
      for (let c = 0; c < a.length; c++) out[c] = a[c]! + (b[c]! - a[c]!) * e;
      return;
    }
    const s = this.#smoothness;
    const ma = this.#slopes[i]!;
    const mb = this.#slopes[i + 1]!;
    // Hermite basis.
    const u2 = u * u;
    const u3 = u2 * u;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    for (let c = 0; c < a.length; c++) {
      const straight = a[c]! + (b[c]! - a[c]!) * u;
      if (s === 0) {
        out[c] = straight;
        continue;
      }
      let spline = a[c]! + (b[c]! - a[c]!) * h01 + (ma[c]! * h10 + mb[c]! * h11) * span;
      // No overshoot past the two stops.
      const lo = Math.min(a[c]!, b[c]!);
      const hi = Math.max(a[c]!, b[c]!);
      spline = spline < lo ? lo : spline > hi ? hi : spline;
      out[c] = straight + (spline - straight) * s;
    }
  }
}

// Oklab, for perceptual mixing (from linear sRGB).
function toOklab(c: RGB): number[] {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab(v: readonly number[], out: number[]): void {
  const [L, a, b] = v as [number, number, number];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  out[0] = clamp01(linearToSrgb(clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)));
  out[1] = clamp01(linearToSrgb(clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)));
  out[2] = clamp01(linearToSrgb(clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)));
}

/** Where a method mixes colours: Oklab, linear light, or the stored (sRGB) values. */
function mixSpace(method: GradientMethod): 'oklab' | 'linear' | 'srgb' {
  return method === 'linear' ? 'linear' : method === 'classic' ? 'srgb' : 'oklab';
}

/** Number of entries in a gradient's lookup table. */
export const GRADIENT_STEPS = 4096;

/**
 * The gradient as RGBA (sRGB 0–1) at `steps` evenly spaced positions (`transparency`
 * false: opaque throughout). Foreground/background stops must be resolved first.
 */
export function gradientTable(
  g: Gradient,
  method: GradientMethod,
  transparency = true,
  steps = GRADIENT_STEPS,
): Float32Array {
  if (g.type === 'noise') return noiseTable(g, transparency, steps);
  const out = new Float32Array(steps * 4);
  const colors = [...g.colorStops].sort((a, b) => a.location - b.location);
  const opacities = [...g.opacityStops].sort((a, b) => a.location - b.location);
  const space = mixSpace(method);
  const encode = (c: RGB) =>
    space === 'oklab' ? toOklab(c) : space === 'linear' ? [c.r, c.g, c.b].map(srgbToLinear) : [c.r, c.g, c.b];
  const colorCurve =
    colors.length > 0
      ? new StopCurve(
          colors,
          colors.map((s) => encode(s.color)),
          method,
          g.smoothness,
        )
      : null;
  // Opacity mixes as plain numbers (Perceptual and Linear only change how colours mix).
  const opacityCurve =
    transparency && opacities.length > 0
      ? new StopCurve(
          opacities,
          opacities.map((s) => [s.opacity]),
          method,
          g.smoothness,
        )
      : null;
  const v = [1, 1, 1];
  const rgb = [1, 1, 1];
  const alpha = [1];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    if (colorCurve) {
      colorCurve.at(t, v);
      if (space === 'oklab') fromOklab(v, rgb);
      else if (space === 'linear') for (let c = 0; c < 3; c++) rgb[c] = clamp01(linearToSrgb(clamp01(v[c]!)));
      else for (let c = 0; c < 3; c++) rgb[c] = clamp01(v[c]!);
    }
    alpha[0] = 1;
    opacityCurve?.at(t, alpha);
    out[i * 4] = rgb[0]!;
    out[i * 4 + 1] = rgb[1]!;
    out[i * 4 + 2] = rgb[2]!;
    out[i * 4 + 3] = clamp01(alpha[0]);
  }
  return out;
}

/** A noise gradient: random values per channel within the ranges, smoother or rougher. */
function noiseTable(g: NoiseGradient, transparency: boolean, steps: number): Float32Array {
  const random = seededRandom(g.seed);
  // Rougher: more random points, joined by straight lines; smoother: fewer, eased.
  const points = 2 + Math.round(g.roughness * 62);
  const channel = (lo: number, hi: number) => Float32Array.from({ length: points }, () => lo + (hi - lo) * random());
  const channels = [0, 1, 2].map((c) => channel(Math.min(g.min[c]!, g.max[c]!), Math.max(g.min[c]!, g.max[c]!)));
  const alpha = channel(0, 1);
  const sample = (values: Float32Array, t: number) => {
    const x = t * (points - 1);
    const i = Math.min(points - 2, Math.floor(x));
    let f = x - i;
    if (g.roughness < 0.5) f = ease(f);
    return values[i]! + (values[i + 1]! - values[i]!) * f;
  };
  const out = new Float32Array(steps * 4);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const x = sample(channels[0]!, t);
    const y = sample(channels[1]!, t);
    const z = sample(channels[2]!, t);
    let rgb: RGB =
      g.model === 'rgb'
        ? { r: x, g: y, b: z }
        : g.model === 'hsb'
          ? hsbToRgb({ h: x * 360, s: y, b: z })
          : labToRgb({ L: x * 100, a: y * 255 - 128, b: z * 255 - 128 });
    if (g.restrictColors) {
      // Keep colours printable-ish: no oversaturated ones.
      const hsb = rgbToHsb(rgb);
      if (hsb.s > 0.8) rgb = hsbToRgb({ ...hsb, s: 0.8 });
    }
    out[i * 4] = clamp01(rgb.r);
    out[i * 4 + 1] = clamp01(rgb.g);
    out[i * 4 + 2] = clamp01(rgb.b);
    out[i * 4 + 3] = transparency && g.addTransparency ? sample(alpha, t) : 1;
  }
  return out;
}

/**
 * A gradient table (sRGB RGBA) as a document's channel values (0–1; 32-bit: linear light)
 * followed by alpha, per entry.
 */
export function gradientSamples(table: Float32Array, mode: ColorMode, depth: BitDepth): Float32Array {
  const cc = mode === 'grayscale' ? 1 : mode === 'rgb' ? 3 : 0;
  if (cc === 0) throw new Error(`Gradients in ${mode} documents need colour management, which is not available yet`);
  const encode = depth === 32 ? srgbToLinear : (v: number) => v;
  const n = table.length / 4;
  const out = new Float32Array(n * (cc + 1));
  for (let i = 0; i < n; i++) {
    const r = table[i * 4]!;
    const g = table[i * 4 + 1]!;
    const b = table[i * 4 + 2]!;
    const o = i * (cc + 1);
    if (cc === 3) {
      out[o] = encode(r);
      out[o + 1] = encode(g);
      out[o + 2] = encode(b);
    } else out[o] = encode(0.299 * r + 0.587 * g + 0.114 * b);
    out[o + cc] = table[i * 4 + 3]!;
  }
  return out;
}

export interface GradientGeometry {
  shape: GradientShape;
  start: { x: number; y: number };
  end: { x: number; y: number };
  reverse: boolean;
}

/** Where along the gradient (0–1) document point (x, y) is. */
export function gradientPosition(g: GradientGeometry, x: number, y: number): number {
  return positionFunction(g)(x, y);
}

/** gradientPosition, prepared for many points. */
export function positionFunction(g: GradientGeometry): (x: number, y: number) => number {
  const sx = g.start.x;
  const sy = g.start.y;
  const dx = g.end.x - sx;
  const dy = g.end.y - sy;
  const len = Math.hypot(dx, dy);
  const rev = g.reverse;
  const finish = (t: number) => {
    const c = t < 0 ? 0 : t > 1 ? 1 : t;
    return rev ? 1 - c : c;
  };
  if (len === 0) return () => finish(0);
  // The drag direction, scaled so the drag length counts as 1.
  const ax = dx / (len * len);
  const ay = dy / (len * len);
  switch (g.shape) {
    case 'linear':
      return (x, y) => finish((x - sx) * ax + (y - sy) * ay);
    case 'reflected':
      return (x, y) => finish(Math.abs((x - sx) * ax + (y - sy) * ay));
    case 'radial':
      return (x, y) => finish(Math.hypot(x - sx, y - sy) / len);
    case 'diamond':
      return (x, y) => {
        const px = x - sx;
        const py = y - sy;
        return finish(Math.abs(px * ax + py * ay) + Math.abs(px * ay - py * ax));
      };
    case 'angle':
      return (x, y) => {
        const px = x - sx;
        const py = y - sy;
        // Counter-clockwise on screen (y down) from the drag direction, once round.
        const a = Math.atan2(px * ay - py * ax, px * ax + py * ay) / (2 * Math.PI);
        return finish(a < 0 ? a + 1 : a);
      };
  }
}

/** Dither noise per pixel, −0.5–0.5 (the same for every replay). */
export function ditherNoise(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5;
}

// ---------------------------------------------------------------------------
// Reading gradients from recordings, files and storage
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const rgb = (v: unknown): RGB => {
  const c = isRaw(v) ? v : {};
  return { r: num(c['r'], 0, 1, 0), g: num(c['g'], 0, 1, 0), b: num(c['b'], 0, 1, 0) };
};

/** A gradient from a recording or a file, checked (values clamped, defaults filled in). */
export function parseGradient(raw: unknown): Gradient {
  if (!isRaw(raw)) throw new Error('gradient: missing');
  const name = typeof raw['name'] === 'string' ? raw['name'] : 'Gradient';
  if (raw['type'] === 'noise') {
    const triple = (v: unknown, fallback: number): [number, number, number] => {
      const a = Array.isArray(v) ? (v as unknown[]) : [];
      return [num(a[0], 0, 1, fallback), num(a[1], 0, 1, fallback), num(a[2], 0, 1, fallback)];
    };
    const model = raw['model'] === 'hsb' || raw['model'] === 'lab' ? raw['model'] : 'rgb';
    return {
      type: 'noise',
      name,
      roughness: num(raw['roughness'], 0, 1, 0.5),
      model,
      min: triple(raw['min'], 0),
      max: triple(raw['max'], 1),
      restrictColors: raw['restrictColors'] === true,
      addTransparency: raw['addTransparency'] === true,
      seed: Math.round(num(raw['seed'], 0, 2 ** 31, 1)),
    };
  }
  const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]) : []).filter(isRaw);
  const colorStops = list(raw['colorStops']).map((s): ColorStop => ({
    location: num(s['location'], 0, 1, 0),
    midpoint: num(s['midpoint'], 0.05, 0.95, 0.5),
    color: rgb(s['color']),
    kind: s['kind'] === 'foreground' || s['kind'] === 'background' ? s['kind'] : 'color',
  }));
  const opacityStops = list(raw['opacityStops']).map((s): OpacityStop => ({
    location: num(s['location'], 0, 1, 0),
    midpoint: num(s['midpoint'], 0.05, 0.95, 0.5),
    opacity: num(s['opacity'], 0, 1, 1),
  }));
  if (colorStops.length === 0) throw new Error('gradient: it has no colour stops');
  return {
    type: 'solid',
    name,
    colorStops,
    opacityStops: opacityStops.length > 0 ? opacityStops : OPAQUE.map((s) => ({ ...s })),
    smoothness: num(raw['smoothness'], 0, 1, 1),
  };
}

/** A deep copy (gradients are plain data). */
export function cloneGradient<G extends Gradient>(g: G): G {
  return JSON.parse(JSON.stringify(g)) as G;
}

/** A group of gradient presets (Gradients panel). */
export interface GradientGroup {
  name: string;
  gradients: { id: string; gradient: Gradient }[];
}

/** Our default gradients, in groups (all ours: no presets from elsewhere). */
export function defaultGradients(): GradientGroup[] {
  const c = (h: string): RGB => ({
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  });
  const even = (name: string, hexes: string[]) =>
    solidGradient(
      name,
      hexes.map((h, i) => ({ location: i / (hexes.length - 1), color: c(h) })),
    );
  const fading = (name: string, kind: ColorStop['kind'], color: RGB = BLACK) =>
    solidGradient(
      name,
      [
        { location: 0, color, kind },
        { location: 1, color, kind },
      ],
      [
        { location: 0, midpoint: 0.5, opacity: 1 },
        { location: 1, midpoint: 0.5, opacity: 0 },
      ],
    );
  const group = (name: string, gradients: Gradient[]): GradientGroup => ({
    name,
    gradients: gradients.map((g) => ({
      id: `pf-grad-${g.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      gradient: cloneGradient(g),
    })),
  });
  return [
    group('Basics', [
      FOREGROUND_TO_BACKGROUND,
      fading('Foreground to Transparent', 'foreground'),
      even('Black, White', ['000000', 'ffffff']),
    ]),
    group('Colors', [
      even('Spectrum', ['ff0000', 'ffff00', '00ff00', '00ffff', '0000ff', 'ff00ff', 'ff0000']),
      even('Dusk', ['2b1055', 'd53369', 'f7b267']),
      even('Lagoon', ['03045e', '0077b6', '90e0ef']),
      even('Moss', ['1b4332', '52b788', 'd8f3dc']),
      even('Ember', ['3d0000', 'd00000', 'ffba08']),
    ]),
    group('Neutrals', [
      even('Warm Gray', ['3e3a36', 'c9c2b8']),
      even('Cool Gray', ['2f3640', 'c8d0da']),
      fading('White to Transparent', 'color', WHITE),
      fading('Black to Transparent', 'color', BLACK),
    ]),
  ];
}
