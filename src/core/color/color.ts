/**
 * Colours for the foreground/background swatches and the Color Picker: sRGB
 * values 0–1 (gamma-encoded), with HSB, hexadecimal and L*a*b* views, and the
 * conversion to a document's samples.
 *
 * Until colour management (Phase 7) every colour is taken as sRGB. Grayscale
 * documents get the luma 0.299 R + 0.587 G + 0.114 B; 32-bit documents linear
 * light. CMYK, Lab and the other modes need ICC conversions and are refused for now.
 */
import type { BitDepth, ColorMode } from '../document/pixel-format';
import { labToLinearSrgb, linearSrgbToLab, type Lab } from './lab';
import { linearToSrgb, srgbToLinear } from './srgb';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface HSB {
  /** Degrees, 0–360. */
  h: number;
  /** 0–1. */
  s: number;
  /** 0–1. */
  b: number;
}

export const BLACK: Readonly<RGB> = Object.freeze({ r: 0, g: 0, b: 0 });
export const WHITE: Readonly<RGB> = Object.freeze({ r: 1, g: 1, b: 1 });

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function rgbToHsb({ r, g, b }: RGB): HSB {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, b: max };
}

export function hsbToRgb({ h, s, b }: HSB): RGB {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = b * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = b - c;
  const [r, g, bl] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return { r: r + m, g: g + m, b: bl + m };
}

/** "RRGGBB" (upper case, no #). */
export function rgbToHex({ r, g, b }: RGB): string {
  return [r, g, b]
    .map((v) =>
      Math.round(clamp01(v) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase();
}

/** Parses "#RGB", "RRGGBB" etc.; null if not a colour. */
export function hexToRgb(text: string): RGB | null {
  let hex = text.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  const n = parseInt(hex, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function rgbToLab({ r, g, b }: RGB): Lab {
  return linearSrgbToLab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
}

/** L*a*b* to sRGB, clipped to the sRGB gamut. */
export function labToRgb(lab: Lab): RGB {
  const [r, g, b] = labToLinearSrgb(lab);
  return { r: clamp01(linearToSrgb(r)), g: clamp01(linearToSrgb(g)), b: clamp01(linearToSrgb(b)) };
}

/** 8-bit values (0–255) of a colour. */
export function rgb8({ r, g, b }: RGB): [number, number, number] {
  return [Math.round(clamp01(r) * 255), Math.round(clamp01(g) * 255), Math.round(clamp01(b) * 255)];
}

export function sameColor(a: RGB, b: RGB): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/** The colour as samples of a document's colour channels (no alpha). */
export function colorToSamples(color: RGB, mode: ColorMode, depth: BitDepth): number[] {
  const encode = (v: number) => {
    const c = clamp01(v);
    if (depth === 32) return srgbToLinear(c);
    return Math.round(c * (depth === 8 ? 255 : 65535));
  };
  switch (mode) {
    case 'rgb':
      return [encode(color.r), encode(color.g), encode(color.b)];
    case 'grayscale':
      return [encode(0.299 * color.r + 0.587 * color.g + 0.114 * color.b)];
    default:
      throw new Error(`Colours in ${mode} documents need colour management, which is not available yet`);
  }
}
