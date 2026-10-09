/**
 * The area the Paint Bucket fills (runs in the pixel worker): pixels whose colour is
 * within Tolerance of the colour clicked — joined to the click (Contiguous) or
 * anywhere — limited by the selection, with soft edges when anti-aliased.
 *
 * Colours are compared premultiplied (so every fully transparent pixel counts as the
 * same colour), as the largest difference of any channel or the alpha, on a 0–255
 * scale. Contiguous areas grow to the four neighbours of each pixel. Anti-alias gives
 * the pixels just outside the area partial coverage — the closer their colour, the
 * more — so a fill meets anti-aliased line art without a gap or a hard fringe.
 * See FORMAT_NOTES §13.
 */
import { flatten, type FlattenPlan } from '../composite/flatten';
import type { Rect } from '../document/geometry';
import { TILE_SIZE, tileIndex } from '../document/tile';
import { MaskReader } from './mask-ops';
import type { MaskData, MaskTile } from './selection';

export interface BucketOptions {
  /** 0–255. */
  tolerance: number;
  contiguous: boolean;
  antiAlias: boolean;
}

/** Side of the square blocks the image is composited in (as the fill reaches them). */
const BLOCK = TILE_SIZE;
const BLOCK_SHIFT = Math.log2(BLOCK);

/**
 * The fill's coverage over the canvas as a mask (document tile grid), or null when the
 * click is outside the canvas or the selection.
 */
export function bucketMask(
  plan: FlattenPlan,
  seed: { x: number; y: number },
  options: BucketOptions,
  selection: MaskData | null,
  canvas: Rect,
): MaskData | null {
  const sx = Math.floor(seed.x);
  const sy = Math.floor(seed.y);
  const w = canvas.w;
  const h = canvas.h;
  if (sx < canvas.x || sy < canvas.y || sx >= canvas.x + w || sy >= canvas.y + h) return null;
  // Selection values over the canvas (null: everything selected).
  let selected: Uint8Array | null = null;
  if (selection) {
    selected = new Uint8Array(w * h);
    const reader = new MaskReader(selection);
    for (let ty = tileIndex(canvas.y); ty <= tileIndex(canvas.y + h - 1); ty++)
      for (let tx = tileIndex(canvas.x); tx <= tileIndex(canvas.x + w - 1); tx++) {
        const tile = reader.layerTile(canvas, 0, 0, tx, ty);
        if (tile === 0) continue;
        const x0 = Math.max(canvas.x, tx * TILE_SIZE);
        const x1 = Math.min(canvas.x + w, (tx + 1) * TILE_SIZE);
        const y0 = Math.max(canvas.y, ty * TILE_SIZE);
        const y1 = Math.min(canvas.y + h, (ty + 1) * TILE_SIZE);
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++)
            selected[(y - canvas.y) * w + (x - canvas.x)] =
              tile === 255 ? 255 : tile[(y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE)]!;
      }
    if (selected[(sy - canvas.y) * w + (sx - canvas.x)] === 0) return null;
  }

  // How far each pixel's colour is from the clicked one (0–255), worked out a block at a
  // time as the fill reaches it (a small fill in a large image composites little of it).
  const stride = plan.colorChannels + 1;
  const target = Array.from(flatten(plan, { x: sx, y: sy, w: 1, h: 1 }).data, (v) => Math.min(1, v));
  const distance = new Uint8Array(w * h);
  const blocksX = Math.ceil(w / BLOCK);
  const measured = new Uint8Array(blocksX * Math.ceil(h / BLOCK));
  const measure = (bx: number, by: number) => {
    measured[by * blocksX + bx] = 1;
    const x0 = bx * BLOCK;
    const y0 = by * BLOCK;
    const bw = Math.min(BLOCK, w - x0);
    const bh = Math.min(BLOCK, h - y0);
    const data = flatten(plan, { x: canvas.x + x0, y: canvas.y + y0, w: bw, h: bh }).data;
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++) {
        const o = (y * bw + x) * stride;
        let d = 0;
        for (let c = 0; c < stride; c++) {
          const diff = Math.abs(Math.min(1, data[o + c]!) - target[c]!);
          if (diff > d) d = diff;
        }
        distance[(y0 + y) * w + x0 + x] = Math.min(255, Math.round(d * 255));
      }
  };

  const tolerance = Math.min(255, Math.max(0, Math.round(options.tolerance)));
  const inside = (x: number, y: number) => {
    const i = y * w + x;
    if (selected !== null && selected[i] === 0) return false;
    if (!measured[(y >> BLOCK_SHIFT) * blocksX + (x >> BLOCK_SHIFT)]) measure(x >> BLOCK_SHIFT, y >> BLOCK_SHIFT);
    return distance[i]! <= tolerance;
  };
  const cover = new Uint8Array(w * h);
  // The covered area's bounds (canvas pixels).
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  if (options.contiguous) {
    // Scanline flood fill from the click over the four neighbours.
    const stack = [(sy - canvas.y) * w + (sx - canvas.x)];
    while (stack.length > 0) {
      const start = stack.pop()!;
      if (cover[start]) continue;
      const y = Math.floor(start / w);
      let x0 = start - y * w;
      if (!inside(x0, y)) continue;
      while (x0 > 0 && !cover[y * w + x0 - 1] && inside(x0 - 1, y)) x0--;
      let up = false;
      let down = false;
      let x = x0;
      for (; x < w; x++) {
        const i = y * w + x;
        if (cover[i] || !inside(x, y)) break;
        cover[i] = 255;
        if (y > 0) {
          const ok = !cover[i - w] && inside(x, y - 1);
          if (ok && !up) stack.push(i - w);
          up = ok;
        }
        if (y < h - 1) {
          const ok = !cover[i + w] && inside(x, y + 1);
          if (ok && !down) stack.push(i + w);
          down = ok;
        }
      }
      minX = Math.min(minX, x0);
      maxX = Math.max(maxX, x - 1);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  } else {
    for (let b = 0; b < measured.length; b++) if (!measured[b]) measure(b % blocksX, Math.floor(b / blocksX));
    for (let y = 0; y < h; y++) {
      let first = -1;
      let last = -1;
      for (let x = 0, i = y * w; x < w; x++, i++) {
        if (distance[i]! > tolerance || (selected !== null && selected[i] === 0)) continue;
        cover[i] = 255;
        if (first < 0) first = x;
        last = x;
      }
      if (first < 0) continue;
      minX = Math.min(minX, first);
      maxX = Math.max(maxX, last);
      minY = Math.min(minY, y);
      maxY = y;
    }
  }
  if (maxX < 0) return null;
  // What may change from here on: the area and the pixels around it.
  const ex0 = Math.max(0, minX - 1);
  const ey0 = Math.max(0, minY - 1);
  const ex1 = Math.min(w - 1, maxX + 1);
  const ey1 = Math.min(h - 1, maxY + 1);

  if (options.antiAlias && tolerance < 255) {
    // Pixels next to the area take partial coverage by how close their colour is (below
    // full, so they never count as the area themselves). Their distances are known: the
    // fill looked at every neighbour of what it covered.
    const ramp = 255 - tolerance;
    for (let y = ey0; y <= ey1; y++)
      for (let x = ex0; x <= ex1; x++) {
        const i = y * w + x;
        if (cover[i]) continue;
        const near =
          (x > 0 && cover[i - 1] === 255) ||
          (x < w - 1 && cover[i + 1] === 255) ||
          (y > 0 && cover[i - w] === 255) ||
          (y < h - 1 && cover[i + w] === 255);
        if (!near) continue;
        const v = Math.round(255 * (1 - (distance[i]! - tolerance) / ramp));
        if (v > 0) cover[i] = Math.min(254, v);
      }
  }
  if (selected)
    for (let y = ey0; y <= ey1; y++)
      for (let x = ex0; x <= ex1; x++) {
        const i = y * w + x;
        if (cover[i]) cover[i] = Math.round((cover[i] * selected[i]!) / 255);
      }

  // As mask tiles on the document's tile grid (empty tiles left out).
  const tiles: MaskTile[] = [];
  for (let ty = tileIndex(canvas.y + ey0); ty <= tileIndex(canvas.y + ey1); ty++)
    for (let tx = tileIndex(canvas.x + ex0); tx <= tileIndex(canvas.x + ex1); tx++) {
      const data = new Uint8Array(TILE_SIZE * TILE_SIZE);
      let any = false;
      const x0 = Math.max(canvas.x + ex0, tx * TILE_SIZE);
      const x1 = Math.min(canvas.x + ex1 + 1, (tx + 1) * TILE_SIZE);
      const y0 = Math.max(canvas.y + ey0, ty * TILE_SIZE);
      const y1 = Math.min(canvas.y + ey1 + 1, (ty + 1) * TILE_SIZE);
      for (let y = y0; y < y1; y++) {
        const from = (y - canvas.y) * w + (x0 - canvas.x);
        const row = cover.subarray(from, from + (x1 - x0));
        if (!any) for (let k = 0; k < row.length && !any; k++) any = row[k] !== 0;
        data.set(row, (y - ty * TILE_SIZE) * TILE_SIZE + (x0 - tx * TILE_SIZE));
      }
      if (any) tiles.push({ tx, ty, data });
    }
  return tiles.length > 0 ? { tiles, fill: 0, offsetX: 0, offsetY: 0 } : null;
}
