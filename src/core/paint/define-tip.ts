/**
 * Edit > Define Brush Preset: the selected area of the visible image becomes a
 * sampled brush tip (runs in the pixel worker).
 *
 * Behaviour (own summary of the reference app): the tip is grayscale — black paints
 * fully, white and transparent areas not at all, greys in between; colour images
 * are converted to gray. A feathered selection gives the tip soft edges. Tips are
 * at most 2500 px on a side.
 */
import { compositeTiles } from '../composite/composite-tiles';
import type { FlattenPlan } from '../composite/flatten';
import type { Rect } from '../document/geometry';
import { TILE_SIZE } from '../document/tile';
import type { MaskData } from '../selection/selection';
import { MaskReader } from '../selection/mask-ops';

/** Coverage (0–255) for each pixel of `rect`: darkness × opacity × selection. */
export function tipFromImage(plan: FlattenPlan, rect: Rect, mask: MaskData | null, canvas: Rect): Uint8Array {
  const cc = plan.colorChannels;
  const format = { depth: 8 as const, colorChannels: cc, hasAlpha: true };
  const tiles = compositeTiles(plan, rect, format, null);
  const byKey = new Map(tiles.map((t) => [`${t.tx},${t.ty}`, t.data]));
  const reader = mask ? new MaskReader(mask) : null;
  const masks = new Map<string, Uint8Array | 0 | 255>();
  const out = new Uint8Array(rect.w * rect.h);
  const spp = cc + 1;
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const dx = rect.x + x;
      const dy = rect.y + y;
      const tx = Math.floor(dx / TILE_SIZE);
      const ty = Math.floor(dy / TILE_SIZE);
      const data = byKey.get(`${tx},${ty}`);
      if (!data) continue; // transparent there
      const p = (dy - ty * TILE_SIZE) * TILE_SIZE + (dx - tx * TILE_SIZE);
      const i = p * spp;
      const gray = cc === 1 ? data[i]! : 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      let m = 255;
      if (reader) {
        const key = `${tx},${ty}`;
        let w = masks.get(key);
        if (w === undefined) masks.set(key, (w = reader.layerTile(canvas, 0, 0, tx, ty)));
        m = w === 0 ? 0 : w === 255 ? 255 : w[p]!;
      }
      out[y * rect.w + x] = Math.round(((255 - gray) * data[i + cc]! * m) / (255 * 255));
    }
  }
  return out;
}
