/**
 * Reference implementation of alpha conversion (used by tests and by the worker).
 * Adding alpha copies the colour samples and sets alpha to fully opaque (only
 * inside `keep`, tile pixel coordinates, when given; transparent elsewhere); removing
 * alpha composites the colour over the matte: c' = c·a + m·(1 − a).
 */
import type { Rect } from '../document/geometry';
import { TILE_SIZE } from '../document/tile';
import {
  createSampleArray,
  maxSampleValue,
  samplesPerPixel,
  type PixelFormat,
  type SampleArray,
} from '../document/pixel-format';

export function convertAlphaTile(
  src: SampleArray,
  from: PixelFormat,
  to: PixelFormat,
  matte: readonly number[],
  out?: SampleArray,
  keep?: Rect | null,
): SampleArray {
  if (from.depth !== to.depth || from.colorChannels !== to.colorChannels)
    throw new Error('convertAlpha: only alpha may differ');
  const sIn = samplesPerPixel(from);
  const sOut = samplesPerPixel(to);
  const pixels = src.length / sIn;
  const dst = out ?? createSampleArray(to.depth, pixels * sOut);
  const cc = from.colorChannels;
  const max = maxSampleValue(from.depth);
  const round = from.depth !== 32;
  for (let p = 0; p < pixels; p++) {
    const i = p * sIn;
    const o = p * sOut;
    if (!from.hasAlpha) {
      for (let c = 0; c < cc; c++) dst[o + c] = src[i + c]!;
      if (to.hasAlpha) {
        const x = p % TILE_SIZE;
        const y = Math.floor(p / TILE_SIZE);
        const inside = !keep || (x >= keep.x && y >= keep.y && x < keep.x + keep.w && y < keep.y + keep.h);
        dst[o + cc] = inside ? max : 0;
      }
    } else if (to.hasAlpha) {
      for (let c = 0; c < sIn; c++) dst[o + c] = src[i + c]!;
    } else {
      const a = src[i + cc]! / max;
      for (let c = 0; c < cc; c++) {
        const v = src[i + c]! * a + (matte[c] ?? 0) * (1 - a);
        dst[o + c] = round ? Math.round(v) : v;
      }
    }
  }
  return dst;
}
