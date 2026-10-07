/**
 * Selection mask operations, run in the pixel worker: drawing shapes (marquees,
 * lassos), feathering, combining with the current selection, inverting, and
 * reading the mask under a layer tile for selection-aware edits.
 *
 * Behaviour (own summary of the reference app; choices in DECISIONS D-026):
 * - Shapes are filled with the even-odd rule (a lasso that loops over itself leaves
 *   holes where it overlaps). With anti-aliasing, edge pixels get partial values
 *   from their coverage (4 sub-rows, exact horizontal coverage); without it a pixel
 *   is selected when its centre is inside.
 * - Feather softens the new shape before it is combined: a Gaussian blur whose
 *   standard deviation is the feather radius (the reference app's 10 px feather
 *   matches a 10 px Gaussian Blur of the mask).
 * - Combining soft masks: Add takes the larger value, Intersect the smaller, and
 *   Subtract keeps min(current, 255 − shape).
 */
import { intersectRects, isEmptyRect, type Rect } from '../document/geometry';
import { TILE_SIZE, tileIndex, tileKey } from '../document/tile';
import type { MaskData, MaskTile } from './selection';

export type SelectionShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'ellipse'; x: number; y: number; w: number; h: number }
  /** Closed polygon: x0, y0, x1, y1, … in document pixels. */
  | { kind: 'polygon'; points: number[] };

export type SelectionMode = 'new' | 'add' | 'subtract' | 'intersect';

const TILE_PIXELS = TILE_SIZE * TILE_SIZE;
type TileMap = Map<number, MaskTile>;

function tileOf(map: TileMap, tx: number, ty: number): MaskTile {
  const key = tileKey(tx, ty);
  let tile = map.get(key);
  if (!tile) map.set(key, (tile = { tx, ty, data: new Uint8Array(TILE_PIXELS) }));
  return tile;
}

/** Polygon vertices of a shape (ellipses become many short segments). */
export function shapePoints(shape: SelectionShape): number[] {
  switch (shape.kind) {
    case 'rect': {
      const { x, y, w, h } = shape;
      return [x, y, x + w, y, x + w, y + h, x, y + h];
    }
    case 'ellipse': {
      const rx = shape.w / 2;
      const ry = shape.h / 2;
      const cx = shape.x + rx;
      const cy = shape.y + ry;
      // Segments of about one pixel keep the outline smooth at any size.
      const n = Math.min(8192, Math.max(32, Math.ceil(2 * Math.PI * Math.max(rx, ry))));
      const pts: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI;
        pts.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
      }
      return pts;
    }
    case 'polygon':
      return shape.points;
  }
}

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** dx/dy. */
  slope: number;
}

/** Fills a polygon (even-odd) into mask tiles on the document grid, within `clip`. */
export function rasterizePolygon(points: readonly number[], antiAlias: boolean, clip: Rect): TileMap {
  const tiles: TileMap = new Map();
  const n = points.length / 2;
  if (n < 3) return tiles;
  const edges: Edge[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const ax = points[i * 2]!;
    const ay = points[i * 2 + 1]!;
    const bx = points[((i + 1) % n) * 2]!;
    const by = points[((i + 1) % n) * 2 + 1]!;
    minX = Math.min(minX, ax);
    maxX = Math.max(maxX, ax);
    minY = Math.min(minY, ay);
    maxY = Math.max(maxY, ay);
    if (ay === by) continue; // horizontal edges never cross a scanline
    const [x0, y0, x1, y1] = ay < by ? [ax, ay, bx, by] : [bx, by, ax, ay];
    edges.push({ x0, y0, x1, y1, slope: (x1 - x0) / (y1 - y0) });
  }
  const area = intersectRects(
    {
      x: Math.floor(minX),
      y: Math.floor(minY),
      w: Math.ceil(maxX) - Math.floor(minX),
      h: Math.ceil(maxY) - Math.floor(minY),
    },
    clip,
  );
  if (isEmptyRect(area)) return tiles;
  edges.sort((a, b) => a.y0 - b.y0);

  const sub = antiAlias ? 4 : 1;
  const row = new Float32Array(area.w);
  const xs: number[] = [];
  let next = 0;
  let active: Edge[] = [];
  for (let y = area.y; y < area.y + area.h; y++) {
    row.fill(0);
    let any = false;
    for (let s = 0; s < sub; s++) {
      const sy = y + (s + 0.5) / sub;
      while (next < edges.length && edges[next]!.y0 <= sy) active.push(edges[next++]!);
      active = active.filter((e) => e.y1 > sy);
      xs.length = 0;
      for (const e of active) if (e.y0 <= sy) xs.push(e.x0 + (sy - e.y0) * e.slope);
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = xs[i]! - area.x;
        const xb = xs[i + 1]! - area.x;
        if (antiAlias) {
          // Exact horizontal coverage of [xa, xb) in each pixel column.
          const first = Math.max(0, Math.floor(xa));
          const last = Math.min(area.w - 1, Math.ceil(xb) - 1);
          for (let px = first; px <= last; px++) {
            const cover = Math.min(px + 1, xb) - Math.max(px, xa);
            if (cover > 0) row[px]! += cover / sub;
          }
        } else {
          // A pixel is in when its centre is.
          const first = Math.max(0, Math.ceil(xa - 0.5));
          const last = Math.min(area.w - 1, Math.ceil(xb - 0.5) - 1);
          for (let px = first; px <= last; px++) row[px] = 1;
        }
        any = true;
      }
    }
    if (!any) continue;
    const ty = tileIndex(y);
    const rowInTile = (y - ty * TILE_SIZE) * TILE_SIZE;
    for (let px = 0; px < area.w; px++) {
      const v = row[px]!;
      if (v <= 0) continue;
      const x = area.x + px;
      const tx = tileIndex(x);
      tileOf(tiles, tx, ty).data[rowInTile + x - tx * TILE_SIZE] = Math.round(Math.min(1, v) * 255);
    }
  }
  return tiles;
}

/** Box widths whose three passes approximate a Gaussian of standard deviation `sigma`. */
function boxesForGauss(sigma: number): number[] {
  const n = 3;
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wl + 2));
}

/** One box-blur pass along a line (values outside are 0). */
function boxLine(src: Float64Array, dst: Float64Array, len: number, radius: number): void {
  const w = 2 * radius + 1;
  let acc = 0;
  for (let i = 0; i < Math.min(radius, len); i++) acc += src[i]!;
  for (let i = 0; i < len; i++) {
    const add = i + radius;
    const remove = i - radius - 1;
    if (add < len) acc += src[add]!;
    if (remove >= 0) acc -= src[remove]!;
    dst[i] = acc / w;
  }
}

/** Feathers mask tiles (Gaussian, standard deviation `radius`), within `clip`. */
export function featherTiles(tiles: TileMap, radius: number, clip: Rect): TileMap {
  if (radius <= 0 || tiles.size === 0) return tiles;
  let bounds: Rect | null = null;
  for (const t of tiles.values()) {
    const r = { x: t.tx * TILE_SIZE, y: t.ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE };
    bounds = bounds
      ? {
          x: Math.min(bounds.x, r.x),
          y: Math.min(bounds.y, r.y),
          w: Math.max(bounds.x + bounds.w, r.x + r.w) - Math.min(bounds.x, r.x),
          h: Math.max(bounds.y + bounds.h, r.y + r.h) - Math.min(bounds.y, r.y),
        }
      : r;
  }
  const margin = Math.ceil(3 * radius);
  const area = intersectRects(
    { x: bounds!.x - margin, y: bounds!.y - margin, w: bounds!.w + 2 * margin, h: bounds!.h + 2 * margin },
    clip,
  );
  if (isEmptyRect(area)) return new Map();
  const { w, h } = area;
  const grid = new Float32Array(w * h);
  for (const t of tiles.values()) {
    const r = intersectRects({ x: t.tx * TILE_SIZE, y: t.ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE }, area);
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        grid[(y - area.y) * w + (x - area.x)] = t.data[(y - t.ty * TILE_SIZE) * TILE_SIZE + (x - t.tx * TILE_SIZE)]!;
      }
    }
  }
  const boxes = boxesForGauss(radius);
  const len = Math.max(w, h);
  const a = new Float64Array(len);
  const b = new Float64Array(len);
  for (const box of boxes) {
    const r = (box - 1) / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) a[x] = grid[y * w + x]!;
      boxLine(a, b, w, r);
      for (let x = 0; x < w; x++) grid[y * w + x] = b[x]!;
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) a[y] = grid[y * w + x]!;
      boxLine(a, b, h, r);
      for (let y = 0; y < h; y++) grid[y * w + x] = b[y]!;
    }
  }
  const out: TileMap = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round(grid[y * w + x]!);
      if (v <= 0) continue;
      const dx = area.x + x;
      const dy = area.y + y;
      const tx = tileIndex(dx);
      const ty = tileIndex(dy);
      tileOf(out, tx, ty).data[(dy - ty * TILE_SIZE) * TILE_SIZE + (dx - tx * TILE_SIZE)] = Math.min(255, v);
    }
  }
  return out;
}

/** Reads windows of a selection mask (its tiles indexed once). */
export class MaskReader {
  readonly mask: MaskData;
  readonly #tiles = new Map<number, Uint8Array>();

  constructor(mask: MaskData) {
    this.mask = mask;
    for (const t of mask.tiles) this.#tiles.set(tileKey(t.tx, t.ty), t.data);
  }

  /**
   * Reads the TILE_SIZE × TILE_SIZE window at document position (x0, y0) into
   * `out` (0 outside the canvas). Returns 0 or 255 instead when the whole window
   * has that value (`out` is then left untouched).
   */
  window(x0: number, y0: number, canvas: Rect, out: Uint8Array): Uint8Array | 0 | 255 {
    const { mask } = this;
    const inside = intersectRects({ x: x0, y: y0, w: TILE_SIZE, h: TILE_SIZE }, canvas);
    if (isEmptyRect(inside)) return 0;
    const lx = x0 - mask.offsetX;
    const ly = y0 - mask.offsetY;
    const local = { x: lx, y: ly, w: TILE_SIZE, h: TILE_SIZE };
    const sources: { data: Uint8Array | undefined; sx: number; sy: number; r: Rect }[] = [];
    for (let ty = tileIndex(ly); ty <= tileIndex(ly + TILE_SIZE - 1); ty++) {
      for (let tx = tileIndex(lx); tx <= tileIndex(lx + TILE_SIZE - 1); tx++) {
        const r = intersectRects({ x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE }, local);
        sources.push({ data: this.#tiles.get(tileKey(tx, ty)), sx: tx * TILE_SIZE, sy: ty * TILE_SIZE, r });
      }
    }
    const whole = inside.w === TILE_SIZE && inside.h === TILE_SIZE;
    if (whole && sources.every((s) => !s.data)) return mask.fill as 0 | 255;
    out.fill(0);
    for (const s of sources) {
      for (let y = s.r.y; y < s.r.y + s.r.h; y++) {
        const o = (y - ly) * TILE_SIZE + (s.r.x - lx);
        if (s.data) {
          const i = (y - s.sy) * TILE_SIZE + (s.r.x - s.sx);
          out.set(s.data.subarray(i, i + s.r.w), o);
        } else if (mask.fill) {
          out.fill(mask.fill, o, o + s.r.w);
        }
      }
    }
    if (!whole) clearOutside(out, x0, y0, inside);
    return out;
  }

  /**
   * The selection under a layer tile (layer tile coordinates and layer offset):
   * mask values aligned to the tile's pixels, or 0 / 255 when uniform.
   */
  layerTile(canvas: Rect, layerOffsetX: number, layerOffsetY: number, tx: number, ty: number): Uint8Array | 0 | 255 {
    const r = this.window(
      tx * TILE_SIZE + layerOffsetX,
      ty * TILE_SIZE + layerOffsetY,
      canvas,
      new Uint8Array(TILE_PIXELS),
    );
    if (typeof r === 'number') return r;
    if (uniform(r, 0)) return 0;
    if (uniform(r, 255)) return 255;
    return r;
  }
}

/** Zeroes the parts of a window at (x0, y0) outside `inside`. */
function clearOutside(out: Uint8Array, x0: number, y0: number, inside: Rect): void {
  for (let y = 0; y < TILE_SIZE; y++) {
    const dy = y0 + y;
    if (dy < inside.y || dy >= inside.y + inside.h) out.fill(0, y * TILE_SIZE, (y + 1) * TILE_SIZE);
    else {
      out.fill(0, y * TILE_SIZE, y * TILE_SIZE + (inside.x - x0));
      out.fill(0, y * TILE_SIZE + (inside.x + inside.w - x0), (y + 1) * TILE_SIZE);
    }
  }
}

function uniform(data: Uint8Array, value: number): boolean {
  for (let i = 0; i < data.length; i++) if (data[i] !== value) return false;
  return true;
}

/** Document tiles of the canvas a mask may touch (its tiles, or the whole canvas when filled). */
function maskTileCoords(mask: MaskData, canvas: Rect, into: Map<number, [number, number]>): void {
  if (mask.fill === 255) {
    for (let ty = tileIndex(canvas.y); ty <= tileIndex(canvas.y + canvas.h - 1); ty++)
      for (let tx = tileIndex(canvas.x); tx <= tileIndex(canvas.x + canvas.w - 1); tx++)
        into.set(tileKey(tx, ty), [tx, ty]);
    return;
  }
  for (const t of mask.tiles) {
    const x = t.tx * TILE_SIZE + mask.offsetX;
    const y = t.ty * TILE_SIZE + mask.offsetY;
    for (let ty = tileIndex(y); ty <= tileIndex(y + TILE_SIZE - 1); ty++)
      for (let tx = tileIndex(x); tx <= tileIndex(x + TILE_SIZE - 1); tx++) into.set(tileKey(tx, ty), [tx, ty]);
  }
}

/** The selection after drawing `shape` in `mode` (null when nothing is selected). */
export function selectShape(
  current: MaskData | null,
  shape: SelectionShape,
  mode: SelectionMode,
  feather: number,
  antiAlias: boolean,
  canvas: Rect,
): MaskData | null {
  let drawn = rasterizePolygon(shapePoints(shape), antiAlias || feather > 0, canvas);
  drawn = featherTiles(drawn, feather, canvas);
  const base = mode === 'new' ? null : current;
  if (!base) {
    if (mode === 'subtract' || mode === 'intersect') return null;
    const tiles = [...drawn.values()].filter((t) => !uniform(t.data, 0));
    return tiles.length ? { tiles, fill: 0, offsetX: 0, offsetY: 0 } : null;
  }
  const fill = mode === 'intersect' ? 0 : base.fill;
  const coords = new Map<number, [number, number]>();
  for (const t of drawn.values()) coords.set(tileKey(t.tx, t.ty), [t.tx, t.ty]);
  if (mode !== 'intersect') maskTileCoords(base, canvas, coords);
  const reader = new MaskReader(base);
  const window = new Uint8Array(TILE_PIXELS);
  const tiles: MaskTile[] = [];
  for (const [tx, ty] of coords.values()) {
    const b = reader.window(tx * TILE_SIZE, ty * TILE_SIZE, canvas, window);
    const d = drawn.get(tileKey(tx, ty))?.data;
    const data = new Uint8Array(TILE_PIXELS);
    for (let i = 0; i < TILE_PIXELS; i++) {
      const bv = typeof b === 'number' ? b : b[i]!;
      const dv = d ? d[i]! : 0;
      data[i] = mode === 'add' ? Math.max(bv, dv) : mode === 'intersect' ? Math.min(bv, dv) : Math.min(bv, 255 - dv);
    }
    // Keep only tiles that differ from the fill somewhere inside the canvas.
    const inside = intersectRects({ x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE }, canvas);
    clearOutside(data, tx * TILE_SIZE, ty * TILE_SIZE, inside);
    if (fill === 255 || !uniform(data, 0)) {
      if (!(fill === 255 && insideUniform(data, tx * TILE_SIZE, ty * TILE_SIZE, inside, 255)))
        tiles.push({ tx, ty, data });
    }
  }
  return finish({ tiles, fill, offsetX: 0, offsetY: 0 }, canvas);
}

/** Select > Inverse. */
export function invertSelection(current: MaskData, canvas: Rect): MaskData | null {
  const tiles = current.tiles.map((t) => {
    const data = new Uint8Array(TILE_PIXELS);
    for (let i = 0; i < TILE_PIXELS; i++) data[i] = 255 - t.data[i]!;
    return { tx: t.tx, ty: t.ty, data };
  });
  return finish({ tiles, fill: 255 - current.fill, offsetX: current.offsetX, offsetY: current.offsetY }, canvas);
}

/** Null for an empty selection. */
function finish(mask: MaskData, canvas: Rect): MaskData | null {
  return maskIsEmpty(mask, canvas) ? null : mask;
}

/** True when no pixel of the canvas is selected. */
export function maskIsEmpty(mask: MaskData, canvas: Rect): boolean {
  if (isEmptyRect(canvas)) return true;
  const reader = new MaskReader(mask);
  const out = new Uint8Array(TILE_PIXELS);
  // Windows aligned to the mask's own grid, so each touches one tile.
  const x0 = canvas.x - ((((canvas.x - mask.offsetX) % TILE_SIZE) + TILE_SIZE) % TILE_SIZE);
  const y0 = canvas.y - ((((canvas.y - mask.offsetY) % TILE_SIZE) + TILE_SIZE) % TILE_SIZE);
  for (let y = y0; y < canvas.y + canvas.h; y += TILE_SIZE) {
    for (let x = x0; x < canvas.x + canvas.w; x += TILE_SIZE) {
      const w = reader.window(x, y, canvas, out);
      if (w === 255 || (typeof w !== 'number' && !uniform(w, 0))) return false;
    }
  }
  return true;
}

/** True when every pixel of `inside` (document coordinates) in the window at (x0, y0) equals `value`. */
function insideUniform(data: Uint8Array, x0: number, y0: number, inside: Rect, value: number): boolean {
  for (let y = inside.y; y < inside.y + inside.h; y++) {
    const row = (y - y0) * TILE_SIZE - x0;
    for (let x = inside.x; x < inside.x + inside.w; x++) if (data[row + x] !== value) return false;
  }
  return true;
}
