/**
 * Composites a flatten plan into layer tiles (for merges, Stamp Visible, Flatten
 * Image and Background from Layer). Runs in the pixel worker.
 *
 * Output tiles follow the document's tile grid (a layer at offset 0, 0). With an
 * alpha channel the result keeps transparency and fully transparent tiles are
 * left out; without one it is composited over `matte`, and tiles that are only the
 * matte colour are left out (they read as the new layer's default pixel).
 */
import { intersectRects, isEmptyRect, type Rect } from '../document/geometry';
import {
  createSampleArray,
  maxSampleValue,
  samplesPerPixel,
  type PixelFormat,
  type SampleArray,
} from '../document/pixel-format';
import { TILE_SIZE, tileIndex } from '../document/tile';
import { flatten, type FlattenPlan } from './flatten';

export interface CompositeTile {
  tx: number;
  ty: number;
  data: SampleArray;
}

/** Allocates the memory for an output tile (shared memory in the worker when available). */
export type TileAllocator = (byteLength: number) => ArrayBuffer | SharedArrayBuffer;

const heap: TileAllocator = (n) => new ArrayBuffer(n);

export function compositeTiles(
  plan: FlattenPlan,
  rect: Rect,
  format: PixelFormat,
  matte: readonly number[] | null,
  allocate: TileAllocator = heap,
): CompositeTile[] {
  if (format.colorChannels !== plan.colorChannels) throw new Error('compositeTiles: colour channels do not match');
  if (!format.hasAlpha && !matte) throw new Error('compositeTiles: a format without alpha needs a matte colour');
  const cc = format.colorChannels;
  const spp = samplesPerPixel(format);
  const max = maxSampleValue(format.depth);
  const float = format.depth === 32;
  const bytes = format.depth === 8 ? 1 : format.depth === 16 ? 2 : 4;
  const matteN = matte ? Array.from({ length: cc }, (_, c) => matte[c]! / max) : null;
  const quantize = (v: number) => (float ? v : Math.round(Math.min(1, Math.max(0, v)) * max));
  const out: CompositeTile[] = [];

  for (let ty = tileIndex(rect.y); ty <= tileIndex(rect.y + rect.h - 1); ty++) {
    for (let tx = tileIndex(rect.x); tx <= tileIndex(rect.x + rect.w - 1); tx++) {
      const tileRect = { x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE };
      const area = intersectRects(tileRect, rect);
      if (isEmptyRect(area)) continue;
      const composite = flatten(plan, area).data;
      const data = createSampleArray(
        format.depth,
        TILE_SIZE * TILE_SIZE * spp,
        allocate(TILE_SIZE * TILE_SIZE * spp * bytes),
      );
      // Outside `rect` the tile is transparent (alpha formats, already zero) or the matte colour.
      if (matte && !format.hasAlpha) {
        for (let i = 0; i < data.length; i += spp) for (let c = 0; c < cc; c++) data[i + c] = matte[c]!;
      }
      let empty = true;
      for (let y = 0; y < area.h; y++) {
        for (let x = 0; x < area.w; x++) {
          const s = (y * area.w + x) * (cc + 1);
          const o = ((area.y - tileRect.y + y) * TILE_SIZE + (area.x - tileRect.x + x)) * spp;
          let a = composite[s + cc]!;
          if (matteN) {
            // Over the matte: premultiplied colour + (1 − a) × matte, fully opaque.
            for (let c = 0; c < cc; c++) data[o + c] = quantize(composite[s + c]! + (1 - a) * matteN[c]!);
            a = 1;
          } else if (a > 0) {
            for (let c = 0; c < cc; c++) data[o + c] = quantize(composite[s + c]! / a);
          }
          if (format.hasAlpha) data[o + cc] = quantize(Math.min(1, a));
          if (empty) {
            if (format.hasAlpha) empty = data[o + cc] === 0;
            else for (let c = 0; c < cc; c++) if (data[o + c] !== matte![c]) empty = false;
          }
        }
      }
      if (!empty) out.push({ tx, ty, data });
    }
  }
  return out;
}
