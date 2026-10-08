/**
 * Edit > Define Pattern (runs in the pixel worker): the visible image within a
 * rectangle, as pattern pixels (RGBA, 8-bit sRGB).
 *
 * The reference app only defines patterns from a rectangular selection without
 * feathering; `rectangular` says whether every pixel of the rectangle is fully
 * selected, so the app can refuse other selections.
 */
import { linearToSrgb } from '../color/srgb';
import { flatten, type FlattenPlan } from '../composite/flatten';
import type { Rect } from '../document/geometry';
import { TILE_SIZE } from '../document/tile';
import { MaskReader } from '../selection/mask-ops';
import type { MaskData } from '../selection/selection';

export function patternFromImage(
  plan: FlattenPlan,
  rect: Rect,
  mask: MaskData | null,
  canvas: Rect,
): { data: Uint8Array; rectangular: boolean } {
  const cc = plan.colorChannels;
  if (cc !== 1 && cc !== 3) throw new Error(`Patterns cannot be defined in ${plan.mode} documents yet`);
  const composite = flatten(plan, rect).data;
  const encode = plan.depth === 32 ? (v: number) => linearToSrgb(Math.min(1, Math.max(0, v))) : (v: number) => v;
  const out = new Uint8Array(rect.w * rect.h * 4);
  for (let i = 0; i < rect.w * rect.h; i++) {
    const s = i * (cc + 1);
    const a = composite[s + cc]!;
    const value = (c: number) =>
      a > 0 ? Math.round(Math.min(1, Math.max(0, encode(composite[s + c]! / a))) * 255) : 0;
    const r = value(0);
    out[i * 4] = r;
    out[i * 4 + 1] = cc === 3 ? value(1) : r;
    out[i * 4 + 2] = cc === 3 ? value(2) : r;
    out[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
  }
  let rectangular = true;
  if (mask) {
    const reader = new MaskReader(mask);
    for (
      let ty = Math.floor(rect.y / TILE_SIZE);
      rectangular && ty <= Math.floor((rect.y + rect.h - 1) / TILE_SIZE);
      ty++
    )
      for (
        let tx = Math.floor(rect.x / TILE_SIZE);
        rectangular && tx <= Math.floor((rect.x + rect.w - 1) / TILE_SIZE);
        tx++
      ) {
        const tile = reader.layerTile(canvas, 0, 0, tx, ty);
        if (tile === 255) continue;
        if (tile === 0) {
          rectangular = false;
          break;
        }
        const x0 = Math.max(rect.x, tx * TILE_SIZE) - tx * TILE_SIZE;
        const x1 = Math.min(rect.x + rect.w, (tx + 1) * TILE_SIZE) - tx * TILE_SIZE;
        const y0 = Math.max(rect.y, ty * TILE_SIZE) - ty * TILE_SIZE;
        const y1 = Math.min(rect.y + rect.h, (ty + 1) * TILE_SIZE) - ty * TILE_SIZE;
        for (let y = y0; rectangular && y < y1; y++)
          for (let x = x0; x < x1; x++)
            if (tile[y * TILE_SIZE + x] !== 255) {
              rectangular = false;
              break;
            }
      }
  }
  return { data: out, rectangular };
}
