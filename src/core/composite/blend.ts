/**
 * Blend mode mathematics (docs/FORMAT_NOTES.md §3). b = backdrop (lower) colour,
 * s = source (layer) colour, both 0–1 in the document's encoding. The GPU shaders
 * (engine/gl/shaders.ts) implement exactly the same formulas.
 *
 * Fill vs. Opacity: for most modes both simply scale the layer's alpha. For the
 * "special eight" (Color Burn, Linear Burn, Color Dodge, Linear Dodge, Vivid Light,
 * Linear Light, Hard Mix, Difference) Fill acts inside the formula — it moves the
 * source towards the mode's neutral colour before blending — while Opacity fades
 * the finished result. See DECISIONS D-023.
 */
import { LAYER_BLEND_MODES, type BlendMode, type LayerBlendMode } from '../document/layers';

export const SPECIAL_EIGHT: ReadonlySet<BlendMode> = new Set([
  'color-burn',
  'linear-burn',
  'color-dodge',
  'linear-dodge',
  'vivid-light',
  'linear-light',
  'hard-mix',
  'difference',
]);

export const NON_SEPARABLE: ReadonlySet<BlendMode> = new Set(['hue', 'saturation', 'color', 'luminosity']);

/** Colour the special-eight modes treat as "no effect" when Fill is lowered. */
function neutral(mode: BlendMode): number {
  switch (mode) {
    case 'color-burn':
    case 'linear-burn':
      return 1;
    case 'vivid-light':
    case 'linear-light':
      return 0.5;
    default:
      return 0; // dodges, difference
  }
}

/** Source colour after applying Fill inside the formula (special eight only). */
export function fillSource(mode: BlendMode, s: number, fill: number): number {
  const n = neutral(mode);
  return n + (s - n) * fill;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Ceiling for 32-bit results that would otherwise be unbounded (Divide by black):
 * the largest value the half-float display composite can hold.
 */
export const HDR_MAX = 65504;

function colorBurn(b: number, s: number): number {
  if (b >= 1) return 1;
  if (s <= 0) return 0;
  return 1 - Math.min(1, (1 - b) / s);
}

function colorDodge(b: number, s: number): number {
  if (b <= 0) return 0;
  if (s >= 1) return 1;
  return Math.min(1, b / (1 - s));
}

/**
 * Separable blend of one channel. `hdr` (32-bit documents) skips clamping to 1
 * where the reference app keeps high values.
 */
export function blendChannel(mode: LayerBlendMode, b: number, s: number, fill = 1, hdr = false): number {
  switch (mode) {
    case 'normal':
    case 'dissolve':
      return s;
    case 'darken':
      return Math.min(b, s);
    case 'multiply':
      return b * s;
    case 'color-burn':
      return colorBurn(b, fillSource(mode, s, fill));
    case 'linear-burn':
      return Math.max(0, b + fillSource(mode, s, fill) - 1);
    case 'lighten':
      return Math.max(b, s);
    case 'screen':
      return b + s - b * s;
    case 'color-dodge':
      return colorDodge(b, fillSource(mode, s, fill));
    case 'linear-dodge': {
      const v = b + fillSource(mode, s, fill);
      return hdr ? v : Math.min(1, v);
    }
    case 'overlay':
      return b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'soft-light':
      return s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (Math.sqrt(b) - b);
    case 'hard-light':
      return s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'vivid-light': {
      const f = fillSource(mode, s, fill);
      return f <= 0.5 ? colorBurn(b, 2 * f) : colorDodge(b, 2 * (f - 0.5));
    }
    case 'linear-light':
      return clamp01(b + 2 * fillSource(mode, s, fill) - 1);
    case 'pin-light':
      return s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1);
    case 'hard-mix':
      // Threshold of b + s at full Fill; lowering Fill softens it into a contrast ramp (D-023).
      if (fill >= 1) return b + s >= 1 ? 1 : 0;
      return clamp01((b - fill * (1 - s)) / (1 - fill));
    case 'difference':
      return Math.abs(b - fillSource(mode, s, fill));
    case 'exclusion':
      return b + s - 2 * b * s;
    case 'subtract':
      return Math.max(0, b - s);
    case 'divide':
      if (s <= 0) return b <= 0 ? 0 : hdr ? HDR_MAX : 1;
      return Math.min(hdr ? HDR_MAX : 1, b / s);
    case 'darker-color':
    case 'lighter-color':
    case 'hue':
    case 'saturation':
    case 'color':
    case 'luminosity':
      throw new Error(`${mode} is not a separable blend mode`);
  }
}

// --- Non-separable modes (whole colours) -------------------------------------

/** Luminosity weights used by the colour/luminosity modes. */
export const LUM_WEIGHTS = [0.3, 0.59, 0.11] as const;

const lum = (c: readonly number[]) => LUM_WEIGHTS[0] * c[0]! + LUM_WEIGHTS[1] * c[1]! + LUM_WEIGHTS[2] * c[2]!;

/** Brings a colour back into range keeping its luminosity (32-bit keeps values above 1). */
function clipColor(c: number[], hdr: boolean): number[] {
  const l = lum(c);
  const n = Math.min(c[0]!, c[1]!, c[2]!);
  const x = Math.max(c[0]!, c[1]!, c[2]!);
  let out = c;
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n));
  if (x > 1 && !hdr) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l));
  return out;
}

function setLum(c: readonly number[], l: number, hdr: boolean): number[] {
  const d = l - lum(c);
  return clipColor([c[0]! + d, c[1]! + d, c[2]! + d], hdr);
}

const sat = (c: readonly number[]) => Math.max(c[0]!, c[1]!, c[2]!) - Math.min(c[0]!, c[1]!, c[2]!);

function setSat(c: readonly number[], s: number): number[] {
  const out = [0, 0, 0];
  const idx = [0, 1, 2].sort((a, b) => c[a]! - c[b]!);
  const [lo, mid, hi] = idx as [number, number, number];
  if (c[hi]! > c[lo]!) {
    out[mid] = ((c[mid]! - c[lo]!) * s) / (c[hi]! - c[lo]!);
    out[hi] = s;
  }
  return out;
}

/** Blend of whole RGB colours for Darker/Lighter Color and Hue/Saturation/Color/Luminosity. */
export function blendColor(mode: LayerBlendMode, b: readonly number[], s: readonly number[], hdr = false): number[] {
  switch (mode) {
    case 'darker-color':
      // The colour with the lower sum of channel values.
      return s[0]! + s[1]! + s[2]! < b[0]! + b[1]! + b[2]! ? [...s] : [...b];
    case 'lighter-color':
      return s[0]! + s[1]! + s[2]! > b[0]! + b[1]! + b[2]! ? [...s] : [...b];
    case 'hue':
      return setLum(setSat(s, sat(b)), lum(b), hdr);
    case 'saturation':
      return setLum(setSat(b, sat(s)), lum(b), hdr);
    case 'color':
      return setLum(s, lum(b), hdr);
    case 'luminosity':
      return setLum(b, lum(s), hdr);
    default:
      throw new Error(`${mode} is a separable blend mode`);
  }
}

export function isWholeColorMode(mode: BlendMode): boolean {
  return NON_SEPARABLE.has(mode) || mode === 'darker-color' || mode === 'lighter-color';
}

/**
 * Deterministic per-pixel noise in [0, 1) for Dissolve, keyed by document position
 * (the same integer hash is used on the GPU).
 */
export function dissolveNoise(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

/** Menu names of the blend modes. */
export const BLEND_MODE_LABELS: Readonly<Record<BlendMode, string>> = {
  'pass-through': 'Pass Through',
  normal: 'Normal',
  dissolve: 'Dissolve',
  darken: 'Darken',
  multiply: 'Multiply',
  'color-burn': 'Color Burn',
  'linear-burn': 'Linear Burn',
  'darker-color': 'Darker Color',
  lighten: 'Lighten',
  screen: 'Screen',
  'color-dodge': 'Color Dodge',
  'linear-dodge': 'Linear Dodge (Add)',
  'lighter-color': 'Lighter Color',
  overlay: 'Overlay',
  'soft-light': 'Soft Light',
  'hard-light': 'Hard Light',
  'vivid-light': 'Vivid Light',
  'linear-light': 'Linear Light',
  'pin-light': 'Pin Light',
  'hard-mix': 'Hard Mix',
  difference: 'Difference',
  exclusion: 'Exclusion',
  subtract: 'Subtract',
  divide: 'Divide',
  hue: 'Hue',
  saturation: 'Saturation',
  color: 'Color',
  luminosity: 'Luminosity',
};

const HDR_MODES: ReadonlySet<BlendMode> = new Set([
  'normal',
  'dissolve',
  'darken',
  'multiply',
  'lighten',
  'linear-dodge',
  'difference',
  'subtract',
  'divide',
  'darker-color',
  'lighter-color',
  'hue',
  'saturation',
  'color',
  'luminosity',
]);

/** Blend modes offered for a document (the reference app limits some colour modes and 32-bit). */
export function availableBlendModes(mode: string, depth: number): readonly LayerBlendMode[] {
  let modes: readonly LayerBlendMode[] = LAYER_BLEND_MODES;
  if (depth === 32) modes = modes.filter((m) => HDR_MODES.has(m));
  if (mode === 'grayscale' || mode === 'bitmap' || mode === 'duotone' || mode === 'multichannel') {
    modes = modes.filter((m) => !NON_SEPARABLE.has(m));
  }
  return modes;
}

/** The Mode menu of painting tools: Behind and Clear follow Dissolve, as in the reference app. */
export function brushModeMenu(mode: string, depth: number): readonly (LayerBlendMode | 'behind' | 'clear')[] {
  const modes = availableBlendModes(mode, depth);
  const at = Math.max(modes.indexOf('dissolve'), modes.indexOf('normal')) + 1;
  return [...modes.slice(0, at), 'behind', 'clear', ...modes.slice(at)];
}

/** The blend-mode menu for a layer: groups add Pass Through at the top. */
export function blendModeMenu(kind: 'pixel' | 'group', mode: string, depth: number): readonly BlendMode[] {
  const modes = availableBlendModes(mode, depth);
  return kind === 'group' ? ['pass-through', ...modes] : modes;
}

/**
 * The mode after (`step` 1) or before (-1) `current` in a menu, wrapping around
 * (Shift+Plus / Shift+Minus). A mode missing from the menu starts at either end.
 */
export function cycleBlendMode(menu: readonly BlendMode[], current: BlendMode, step: 1 | -1): BlendMode {
  const i = menu.indexOf(current);
  if (i < 0) return step > 0 ? menu[0]! : menu[menu.length - 1]!;
  return menu[(i + step + menu.length) % menu.length]!;
}
