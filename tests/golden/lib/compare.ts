/**
 * Perceptual image comparison with CIEDE2000.
 *
 * Each pixel of both images is composited (in linear light) over black and over
 * white, converted to L*a*b* (D50) and compared; the pixel's difference is the
 * larger of the two ΔE00 values. This catches colour and alpha differences alike,
 * while colour hidden under zero alpha is ignored.
 */
import { deltaE2000 } from '../../../src/core/color/deltaE';
import { linearSrgbToLab, type Lab } from '../../../src/core/color/lab';
import { srgb16ToLinearTable, srgb8ToLinearTable } from '../../../src/core/color/srgb';
import { createImage, type RgbaImage } from './image';

/** Default tolerances from CLAUDE.md §4: ΔE00 ≤ 1.0 on average, ≤ 3.0 at worst. */
export const DEFAULT_TOLERANCE = { avgDeltaE: 1.0, maxDeltaE: 3.0 } as const;

export interface CompareOptions {
  avgDeltaE?: number;
  maxDeltaE?: number;
}

export interface CompareResult {
  pass: boolean;
  avgDeltaE: number;
  maxDeltaE: number;
  /** Location of the largest difference. */
  maxAt: { x: number; y: number };
  /** Pixels whose difference exceeds `maxDeltaE`. */
  failingPixels: number;
  /** 8-bit heat map: dimmed expected image, red where ΔE grows, magenta where it fails. */
  diff: RgbaImage;
  tolerance: Required<CompareOptions>;
}

/** Returns a reader yielding linear-light RGBA for pixel index i (alpha 0–1). */
function linearReader(image: RgbaImage): (i: number, out: Float64Array) => void {
  const { data, depth } = image;
  if (depth === 32) {
    return (i, out) => {
      out[0] = data[i]!;
      out[1] = data[i + 1]!;
      out[2] = data[i + 2]!;
      out[3] = Math.min(1, Math.max(0, data[i + 3]!));
    };
  }
  const lut = depth === 8 ? srgb8ToLinearTable() : srgb16ToLinearTable();
  const max = depth === 8 ? 255 : 65535;
  return (i, out) => {
    out[0] = lut[data[i]!]!;
    out[1] = lut[data[i + 1]!]!;
    out[2] = lut[data[i + 2]!]!;
    out[3] = data[i + 3]! / max;
  };
}

export function compareImages(actual: RgbaImage, expected: RgbaImage, options: CompareOptions = {}): CompareResult {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(
      `Image size mismatch: actual ${actual.width}×${actual.height}, expected ${expected.width}×${expected.height}`,
    );
  }
  const tolerance = { ...DEFAULT_TOLERANCE, ...options };
  const readA = linearReader(actual);
  const readE = linearReader(expected);
  const pa = new Float64Array(4);
  const pe = new Float64Array(4);
  const labA: Lab = { L: 0, a: 0, b: 0 };
  const labE: Lab = { L: 0, a: 0, b: 0 };
  const diff = createImage(actual.width, actual.height, 8);
  const expected8 = toDisplay8(expected);

  let sum = 0;
  let max = 0;
  let maxAt = { x: 0, y: 0 };
  let failing = 0;
  const n = actual.width * actual.height;

  for (let p = 0; p < n; p++) {
    const i = p * 4;
    readA(i, pa);
    readE(i, pe);
    let dE = 0;
    for (const bg of [0, 1]) {
      const ia = 1 - pa[3]!;
      const ie = 1 - pe[3]!;
      linearSrgbToLab(pa[0]! * pa[3]! + bg * ia, pa[1]! * pa[3]! + bg * ia, pa[2]! * pa[3]! + bg * ia, labA);
      linearSrgbToLab(pe[0]! * pe[3]! + bg * ie, pe[1]! * pe[3]! + bg * ie, pe[2]! * pe[3]! + bg * ie, labE);
      dE = Math.max(dE, deltaE2000(labA, labE));
    }
    sum += dE;
    if (dE > max) {
      max = dE;
      maxAt = { x: p % actual.width, y: Math.floor(p / actual.width) };
    }
    const fails = dE > tolerance.maxDeltaE;
    if (fails) failing++;

    // Heat map: a dim grey version of the expected image, red rising with ΔE.
    const grey = expected8[p]! * 0.3;
    const heat = Math.min(1, dE / tolerance.maxDeltaE);
    diff.data[i] = fails ? 255 : Math.round(grey + heat * (255 - grey));
    diff.data[i + 1] = fails ? 0 : Math.round(grey * (1 - heat));
    diff.data[i + 2] = fails ? 255 : Math.round(grey * (1 - heat));
    diff.data[i + 3] = 255;
  }

  const avgDeltaE = n === 0 ? 0 : sum / n;
  return {
    pass: avgDeltaE <= tolerance.avgDeltaE && max <= tolerance.maxDeltaE,
    avgDeltaE,
    maxDeltaE: max,
    maxAt,
    failingPixels: failing,
    diff,
    tolerance,
  };
}

/** Luminance (0–255) of each pixel composited over mid grey, for the heat-map background. */
function toDisplay8(image: RgbaImage): Uint8Array {
  const read = linearReader(image);
  const px = new Float64Array(4);
  const out = new Uint8Array(image.width * image.height);
  for (let p = 0; p < out.length; p++) {
    read(p * 4, px);
    const y = 0.2126 * px[0]! + 0.7152 * px[1]! + 0.0722 * px[2]!;
    const composited = y * px[3]! + 0.214 * (1 - px[3]!);
    out[p] = Math.round(255 * Math.min(1, Math.max(0, composited)) ** (1 / 2.2));
  }
  return out;
}
