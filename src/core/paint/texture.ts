/**
 * Brush Texture, Dual Brush, Noise and Wet Edges as coverage arithmetic (the stroke
 * renderer applies them per pixel; formulas also in FORMAT_NOTES §8).
 *
 * Behaviour (own summary of the reference app):
 * - Texture: a pattern fixed to the canvas shows through the paint. Light parts of
 *   the pattern take the most paint, dark parts the least (Invert swaps that). Depth
 *   sets how far paint gets into the dark parts: 0 % hides the pattern, 100 % leaves
 *   the darkest parts bare. Scale, Brightness and Contrast adjust the pattern first.
 *   With Texture Each Tip every dab is textured as it is laid (so dabs that overlap
 *   fill the pattern in, and Depth can vary per dab); otherwise the stroke as a whole.
 *   Modes say how pattern and paint combine; Height and Linear Height treat the
 *   pattern as a relief that harder pressure reaches deeper into.
 * - Dual Brush: a second tip, stamped along the same path, masks the stroke; its
 *   mode says how the two combine. Paint stays inside the main stroke.
 * - Noise roughens the soft edges of tips (no effect on fully hard edges).
 * - Wet Edges: paint gathers at the edges of the stroke, like watercolour, the
 *   middle staying lighter.
 */

export type TextureMode =
  | 'multiply'
  | 'subtract'
  | 'darken'
  | 'overlay'
  | 'color-dodge'
  | 'color-burn'
  | 'linear-burn'
  | 'hard-mix'
  | 'linear-height'
  | 'height';

export const TEXTURE_MODES: readonly [TextureMode, string][] = [
  ['multiply', 'Multiply'],
  ['subtract', 'Subtract'],
  ['darken', 'Darken'],
  ['overlay', 'Overlay'],
  ['color-dodge', 'Color Dodge'],
  ['color-burn', 'Color Burn'],
  ['linear-burn', 'Linear Burn'],
  ['hard-mix', 'Hard Mix'],
  ['linear-height', 'Linear Height'],
  ['height', 'Height'],
];

export type DualMode =
  'multiply' | 'darken' | 'overlay' | 'color-dodge' | 'color-burn' | 'linear-burn' | 'hard-mix' | 'linear-height';

export const DUAL_MODES: readonly [DualMode, string][] = [
  ['multiply', 'Multiply'],
  ['darken', 'Darken'],
  ['overlay', 'Overlay'],
  ['color-dodge', 'Color Dodge'],
  ['color-burn', 'Color Burn'],
  ['linear-burn', 'Linear Burn'],
  ['hard-mix', 'Hard Mix'],
  ['linear-height', 'Linear Height'],
];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Gray level (0–255) → texture value t (0–1, 1 = takes paint) after Brightness
 * (−150…150, added to the level), Contrast (−50…100, stretching about mid-gray:
 * ×(1 + c/25) above 0, ×(1 + c/50) below) and Invert.
 */
export function textureLut(brightness: number, contrast: number, invert: boolean): Float32Array {
  const k = contrast >= 0 ? 1 + contrast / 25 : 1 + contrast / 50;
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const t = clamp01(((v - 127.5) * k + 127.5 + brightness) / 255);
    lut[v] = invert ? 1 - t : t;
  }
  return lut;
}

/** How far a Height relief level reaches: level = a × (1 + HEIGHT_GAIN × depth). */
const HEIGHT_GAIN = 4;
/** Softness of the Height threshold (a share of the texture range). */
const HEIGHT_SOFT = 0.25;

/** Relief `t` reached by paint up to `level`: covered where the relief stands above 1 − level. */
const height = (t: number, level: number) => clamp01((t + level - 1) / HEIGHT_SOFT);

/** Paint amount `a` (0–1) textured by value `t` (0–1) at depth `d` (0–1). Depth 0 leaves `a` (except the Height modes). */
export function applyTexture(mode: TextureMode, a: number, t: number, d: number): number {
  switch (mode) {
    case 'multiply':
      return a * (1 - d * (1 - t));
    case 'subtract':
      return Math.max(0, a - d * (1 - t));
    case 'darken':
      return Math.min(a, 1 - d * (1 - t));
    case 'overlay': {
      const b = 0.5 + d * (t - 0.5);
      return a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b);
    }
    case 'color-dodge':
      return Math.min(1, a / Math.max(1e-3, 1 - d * t));
    case 'color-burn': {
      const b = 1 - d * (1 - t);
      return b <= 0 ? 0 : Math.max(0, 1 - (1 - a) / b);
    }
    case 'linear-burn':
      return Math.max(0, a - 2 * d * (1 - t));
    case 'hard-mix':
      // Linear Burn with the contrast rising to a hard threshold at full depth.
      return clamp01((a - d * (1 - t)) / Math.max(0.01, 1 - d));
    case 'height':
      return height(t, a * (1 + HEIGHT_GAIN * d));
    case 'linear-height':
      return Math.max(height(t, a * (1 + HEIGHT_GAIN * d)), a * t);
  }
}

/** The main stroke's coverage `c` masked by the dual tip's coverage `m` (both 0–1). */
export function combineDual(mode: DualMode, c: number, m: number): number {
  switch (mode) {
    case 'multiply':
      return c * m;
    case 'darken':
      return Math.min(c, m);
    case 'overlay':
      return c < 0.5 ? 2 * c * m : 1 - 2 * (1 - c) * (1 - m);
    case 'color-dodge':
      return c === 0 ? 0 : Math.min(1, c / Math.max(1e-3, 1 - m));
    case 'color-burn':
      return m <= 0 ? 0 : Math.max(0, 1 - (1 - c) / m);
    case 'linear-burn':
      return Math.max(0, c + m - 1);
    case 'hard-mix':
      return clamp01((c + m - 1) / 0.05);
    case 'linear-height':
      return Math.max(height(m, c), c * m);
  }
}

/** A fixed noise value 0–1 for document pixel (x, y) (an integer hash, so it never moves). */
export function paintNoise(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Noise: tip coverage roughened where it is partial (most at 50 %, none where 0 or 1). */
export function addNoise(cov: number, x: number, y: number): number {
  const edge = 4 * cov * (1 - cov);
  return clamp01(cov + (paintNoise(x, y) - 0.5) * 2 * edge);
}

/** Wet Edges: the rim is this share of each dab's diameter (at least a pixel). */
export const WET_RIM = 0.1;

/**
 * Wet Edges: the stroke's coverage `c` → opacity, given how much of it is interior (`k`, 0–1: the
 * share also covered by the dabs shrunk by the rim). The middle stays at half; hard tips get a
 * darker rim (up to 90 %), soft tips a darker ring where coverage is about 80 %.
 */
export function wetEdge(c: number, k: number): number {
  return Math.max(c * (0.5 + 0.4 * (1 - k)), Math.min(c, 0.5 + 1.5 * (1 - c)));
}
