/**
 * Whole-layer geometry for Image Size, Canvas Size, Crop and Image Rotation
 * (runs in the pixel worker). Every function returns the layer's new tiles on the
 * document tile grid (the layer then sits at offset 0, 0).
 *
 * - `mapLayer` moves pixels exactly: shifts, quarter turns and flips.
 * - `resampleLayer` scales with a resampling filter, on premultiplied colour so
 *   transparent edges do not darken (FORMAT_NOTES §6).
 *
 * Layers without alpha (the Background) cover exactly the canvas: where the old
 * canvas does not reach, they get `fill` (the canvas extension colour), and the
 * returned tiles leave out areas that are only `fill` (the new default pixel).
 *
 * Pixels are read a row or column at a time (whole runs copied from each tile), so
 * the per-pixel work is only the arithmetic.
 */
import { intersectRects, isEmptyRect, type Rect } from '../document/geometry';
import {
  createSampleArray,
  maxSampleValue,
  samplesPerPixel,
  type PixelFormat,
  type SampleArray,
} from '../document/pixel-format';
import { TILE_SIZE, tileIndex, tileKey } from '../document/tile';

export interface LayerSource {
  format: PixelFormat;
  defaultPixel: readonly number[];
  offsetX: number;
  offsetY: number;
  tiles: { tx: number; ty: number; data: SampleArray }[];
  /** Where the default pixel counts (the old canvas, for the Background); elsewhere: `fill` or transparent. */
  domain: Rect | null;
}

export interface LayerTile {
  tx: number;
  ty: number;
  data: SampleArray;
}

/** Where an output pixel comes from: document coordinates before the change. */
export type PixelMap =
  | { kind: 'shift'; dx: number; dy: number }
  /** Quarter turns clockwise about the old canvas (`width` × `height`). */
  | { kind: 'rotate'; turns: 1 | 2 | 3; width: number; height: number }
  | { kind: 'flip'; axis: 'horizontal' | 'vertical'; width: number; height: number };

export type ResampleMethod = 'nearest' | 'bilinear' | 'bicubic' | 'bicubic-smoother' | 'bicubic-sharper' | 'automatic';

export type Allocator = (byteLength: number) => ArrayBuffer | SharedArrayBuffer;
const heap: Allocator = (n) => new ArrayBuffer(n);

type Samples = SampleArray | Float32Array;

function fillRun(out: Samples, o: number, n: number, pixel: readonly number[], spp: number): void {
  if (n <= 0) return;
  for (let c = 0; c < spp; c++) out[o + c] = pixel[c] ?? 0;
  // Double the filled part until the run is complete.
  const end = o + n * spp;
  for (let done = spp; o + done < end; done *= 2) out.copyWithin(o + done, o, Math.min(o + done * 2, end) - done);
}

/** Copies a layer's pixels by rows and columns (document coordinates). */
class SourcePixels {
  readonly #src: LayerSource;
  readonly #spp: number;
  readonly #tiles = new Map<number, SampleArray>();
  /** What lies outside the domain: the fill colour, or transparency. */
  readonly #outside: readonly number[];

  constructor(src: LayerSource, fill: readonly number[] | null) {
    this.#src = src;
    this.#spp = samplesPerPixel(src.format);
    for (const t of src.tiles) this.#tiles.set(tileKey(t.tx, t.ty), t.data);
    this.#outside = fill ?? new Array<number>(this.#spp).fill(0);
  }

  /** Pixels (x0 … x0 + n − 1, y) into `out` from sample `o`. */
  row(y: number, x0: number, n: number, out: Samples, o: number): void {
    const { offsetX, offsetY, domain: d, defaultPixel } = this.#src;
    const spp = this.#spp;
    const end = x0 + n;
    const a = d ? Math.max(x0, d.x) : x0;
    const b = d ? Math.min(end, d.x + d.w) : end;
    if ((d && (y < d.y || y >= d.y + d.h)) || a >= b) {
      fillRun(out, o, n, this.#outside, spp);
      return;
    }
    fillRun(out, o, a - x0, this.#outside, spp);
    const ly = y - offsetY;
    const ty = tileIndex(ly);
    const rowStart = (ly - ty * TILE_SIZE) * TILE_SIZE;
    for (let x = a; x < b;) {
      const lx = x - offsetX;
      const tx = tileIndex(lx);
      const start = lx - tx * TILE_SIZE;
      const run = Math.min(TILE_SIZE - start, b - x);
      const data = this.#tiles.get(tileKey(tx, ty));
      const dst = o + (x - x0) * spp;
      if (data) out.set(data.subarray((rowStart + start) * spp, (rowStart + start + run) * spp), dst);
      else fillRun(out, dst, run, defaultPixel, spp);
      x += run;
    }
    fillRun(out, o + (b - x0) * spp, end - b, this.#outside, spp);
  }

  /** Pixels (x, y0 … y0 + n − 1) into `out` from sample `o`. */
  column(x: number, y0: number, n: number, out: Samples, o: number): void {
    const { offsetX, offsetY, domain: d, defaultPixel } = this.#src;
    const spp = this.#spp;
    const end = y0 + n;
    const a = d ? Math.max(y0, d.y) : y0;
    const b = d ? Math.min(end, d.y + d.h) : end;
    if ((d && (x < d.x || x >= d.x + d.w)) || a >= b) {
      fillRun(out, o, n, this.#outside, spp);
      return;
    }
    fillRun(out, o, a - y0, this.#outside, spp);
    const lx = x - offsetX;
    const tx = tileIndex(lx);
    const col = lx - tx * TILE_SIZE;
    for (let y = a; y < b;) {
      const ly = y - offsetY;
      const ty = tileIndex(ly);
      const start = ly - ty * TILE_SIZE;
      const run = Math.min(TILE_SIZE - start, b - y);
      const data = this.#tiles.get(tileKey(tx, ty));
      const dst = o + (y - y0) * spp;
      if (data) {
        for (let i = 0; i < run; i++) {
          const s = ((start + i) * TILE_SIZE + col) * spp;
          for (let c = 0; c < spp; c++) out[dst + i * spp + c] = data[s + c]!;
        }
      } else fillRun(out, dst, run, defaultPixel, spp);
      y += run;
    }
    fillRun(out, o + (b - y0) * spp, end - b, this.#outside, spp);
  }
}

/** The document area a layer's pixels cover (tile-aligned), or its domain for opaque layers. */
export function sourceBounds(src: LayerSource): Rect {
  if (!src.format.hasAlpha && src.domain) return src.domain;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const t of src.tiles) {
    x0 = Math.min(x0, t.tx * TILE_SIZE + src.offsetX);
    y0 = Math.min(y0, t.ty * TILE_SIZE + src.offsetY);
    x1 = Math.max(x1, (t.tx + 1) * TILE_SIZE + src.offsetX);
    y1 = Math.max(y1, (t.ty + 1) * TILE_SIZE + src.offsetY);
  }
  return x0 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Where a document point lands after the change (for bounds). */
function forward(map: PixelMap, x: number, y: number): [number, number] {
  switch (map.kind) {
    case 'shift':
      return [x + map.dx, y + map.dy];
    case 'rotate':
      return map.turns === 1
        ? [map.height - y, x]
        : map.turns === 2
          ? [map.width - x, map.height - y]
          : [y, map.width - x];
    case 'flip':
      return map.axis === 'horizontal' ? [map.width - x, y] : [x, map.height - y];
  }
}

function newTile(format: PixelFormat, allocate: Allocator): SampleArray {
  const n = TILE_SIZE * TILE_SIZE * samplesPerPixel(format);
  const bytes = format.depth === 8 ? 1 : format.depth === 16 ? 2 : 4;
  return createSampleArray(format.depth, n, allocate(n * bytes));
}

/** True when a finished tile holds nothing but transparency (or only `fill`, for opaque layers). */
function tileIsBlank(data: SampleArray, format: PixelFormat, fill: readonly number[] | null): boolean {
  const spp = samplesPerPixel(format);
  const cc = format.colorChannels;
  if (format.hasAlpha) {
    for (let i = cc; i < data.length; i += spp) if (data[i] !== 0) return false;
    return true;
  }
  if (!fill) return false;
  for (let i = 0; i < data.length; i += spp) for (let c = 0; c < cc; c++) if (data[i + c] !== fill[c]) return false;
  return true;
}

/** Copies `n` pixels from `from` into `out` at `o`, last pixel first. */
function reversed(from: Samples, n: number, spp: number, out: Samples, o: number): void {
  for (let i = 0; i < n; i++) {
    const s = (n - 1 - i) * spp;
    for (let c = 0; c < spp; c++) out[o + i * spp + c] = from[s + c]!;
  }
}

/**
 * Moves a layer's pixels exactly (shift, rotate, flip). `clip` limits the result
 * (the new canvas, for the Background or Delete Cropped Pixels).
 */
export function mapLayer(
  src: LayerSource,
  map: PixelMap,
  clip: Rect | null,
  fill: readonly number[] | null,
  allocate: Allocator = heap,
): LayerTile[] {
  const format = src.format;
  const spp = samplesPerPixel(format);
  const b = sourceBounds(src);
  const corners = [forward(map, b.x, b.y), forward(map, b.x + b.w, b.y + b.h)];
  let rect: Rect = {
    x: Math.min(corners[0]![0], corners[1]![0]),
    y: Math.min(corners[0]![1], corners[1]![1]),
    w: Math.abs(corners[1]![0] - corners[0]![0]),
    h: Math.abs(corners[1]![1] - corners[0]![1]),
  };
  if (clip) rect = intersectRects(rect, clip);
  if (!format.hasAlpha && clip) rect = clip; // the Background always covers the canvas
  const out: LayerTile[] = [];
  if (isEmptyRect(rect)) return out;
  const read = new SourcePixels(src, fill);
  const tmp = createSampleArray(format.depth, TILE_SIZE * spp);
  const W = map.kind === 'shift' ? 0 : map.width;
  const H = map.kind === 'shift' ? 0 : map.height;

  for (let ty = tileIndex(rect.y); ty <= tileIndex(rect.y + rect.h - 1); ty++) {
    for (let tx = tileIndex(rect.x); tx <= tileIndex(rect.x + rect.w - 1); tx++) {
      const area = intersectRects({ x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE }, rect);
      if (isEmptyRect(area)) continue;
      const data = newTile(format, allocate);
      const whole = area.w === TILE_SIZE && area.h === TILE_SIZE;
      if (fill && !format.hasAlpha && !whole) fillRun(data, 0, TILE_SIZE * TILE_SIZE, fill, spp);
      const n = area.w;
      for (let y = area.y; y < area.y + area.h; y++) {
        const o = ((y - ty * TILE_SIZE) * TILE_SIZE + (area.x - tx * TILE_SIZE)) * spp;
        // Each output row is a source row or column, read forwards or backwards.
        if (map.kind === 'shift') read.row(y - map.dy, area.x - map.dx, n, data, o);
        else if (map.kind === 'flip' && map.axis === 'vertical') read.row(H - 1 - y, area.x, n, data, o);
        else if (map.kind === 'flip' || map.turns === 2) {
          read.row(map.kind === 'flip' ? y : H - 1 - y, W - area.x - n, n, tmp, 0);
          reversed(tmp, n, spp, data, o);
        } else if (map.turns === 1) {
          read.column(y, H - area.x - n, n, tmp, 0); // (x, y) ← (y, H − 1 − x)
          reversed(tmp, n, spp, data, o);
        } else {
          read.column(W - 1 - y, area.x, n, data, o); // (x, y) ← (W − 1 − y, x)
        }
      }
      if (!tileIsBlank(data, format, fill)) out.push({ tx, ty, data });
    }
  }
  return out;
}

// --- Resampling -------------------------------------------------------------

interface Kernel {
  radius: number;
  weight: (t: number) => number;
}

function cubic(b: number, c: number): Kernel {
  return {
    radius: 2,
    weight: (t) => {
      const x = Math.abs(t);
      if (x < 1) return ((12 - 9 * b - 6 * c) * x ** 3 + (-18 + 12 * b + 6 * c) * x ** 2 + (6 - 2 * b)) / 6;
      if (x < 2)
        return ((-b - 6 * c) * x ** 3 + (6 * b + 30 * c) * x ** 2 + (-12 * b - 48 * c) * x + (8 * b + 24 * c)) / 6;
      return 0;
    },
  };
}

/** The filter of a method (Automatic: smoother for enlarging, sharper for reducing). */
export function resampleKernel(method: ResampleMethod, scale: number): Kernel | null {
  const m = method === 'automatic' ? (scale >= 1 ? 'bicubic-smoother' : 'bicubic-sharper') : method;
  switch (m) {
    case 'nearest':
      return null;
    case 'bilinear':
      return { radius: 1, weight: (t) => Math.max(0, 1 - Math.abs(t)) };
    case 'bicubic':
      return cubic(0, 0.5); // Catmull-Rom
    case 'bicubic-smoother':
      return cubic(1 / 3, 1 / 3); // Mitchell–Netravali: softer, for enlarging
    case 'bicubic-sharper':
      return cubic(0, 0.75); // stronger overshoot: crisper reductions
  }
}

/**
 * Which source pixels feed each of `count` output pixels from `n0` along one axis,
 * as flat arrays: output i uses `taps` source pixels from `first[i]`, with weights
 * `weights[i * taps …]` (zero-padded).
 */
function contributions(n0: number, count: number, scale: number, kernel: Kernel | null) {
  const stretch = Math.max(1, 1 / scale); // widen the filter when reducing (anti-aliasing)
  const taps = kernel ? Math.ceil(kernel.radius * stretch) * 2 + 1 : 1;
  const first = new Int32Array(count);
  const weights = new Float32Array(count * taps);
  for (let i = 0; i < count; i++) {
    const centre = (n0 + i + 0.5) / scale - 0.5;
    if (!kernel) {
      first[i] = Math.floor(centre + 0.5);
      weights[i] = 1;
      continue;
    }
    const r = kernel.radius * stretch;
    const f = Math.ceil(centre - r);
    const last = Math.min(Math.floor(centre + r), f + taps - 1);
    first[i] = f;
    let sum = 0;
    for (let s = f; s <= last; s++) {
      const w = kernel.weight((s - centre) / stretch);
      weights[i * taps + s - f] = w;
      sum += w;
    }
    if (sum !== 0) for (let k = 0; k < taps; k++) weights[i * taps + k]! /= sum;
  }
  return { first, weights, taps };
}

/** Scales a layer by (scaleX, scaleY) about the document origin. `clip`: the new canvas (Background). */
export function resampleLayer(
  src: LayerSource,
  scaleX: number,
  scaleY: number,
  method: ResampleMethod,
  clip: Rect | null,
  fill: readonly number[] | null,
  allocate: Allocator = heap,
): LayerTile[] {
  const format = src.format;
  const cc = format.colorChannels;
  const spp = samplesPerPixel(format);
  const stride = cc + 1;
  const max = maxSampleValue(format.depth);
  const b = sourceBounds(src);
  let rect: Rect = {
    x: Math.floor(b.x * scaleX),
    y: Math.floor(b.y * scaleY),
    w: Math.ceil((b.x + b.w) * scaleX) - Math.floor(b.x * scaleX),
    h: Math.ceil((b.y + b.h) * scaleY) - Math.floor(b.y * scaleY),
  };
  if (clip) rect = format.hasAlpha ? intersectRects(rect, clip) : clip;
  const tiles: LayerTile[] = [];
  if (isEmptyRect(rect)) return tiles;
  const kx = resampleKernel(method, scaleX);
  const ky = resampleKernel(method, scaleY);
  const read = new SourcePixels(src, fill);
  // Opaque layers repeat their edge pixels past the old canvas, so the edges keep their colour.
  const d = !format.hasAlpha ? src.domain : null;
  const clampX = d ? (x: number) => Math.min(d.x + d.w - 1, Math.max(d.x, x)) : (x: number) => x;
  const clampY = d ? (y: number) => Math.min(d.y + d.h - 1, Math.max(d.y, y)) : (y: number) => y;
  const q = format.depth === 32 ? (v: number) => v : (v: number) => Math.round(Math.min(max, Math.max(0, v)));
  const acc = new Float64Array(stride);

  // Tile by tile: a horizontal pass over the source rows the tile needs, then a vertical one.
  for (let ty = tileIndex(rect.y); ty <= tileIndex(rect.y + rect.h - 1); ty++) {
    for (let tx = tileIndex(rect.x); tx <= tileIndex(rect.x + rect.w - 1); tx++) {
      const area = intersectRects({ x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE }, rect);
      if (isEmptyRect(area)) continue;
      const cols = contributions(area.x, area.w, scaleX, kx);
      const rows = contributions(area.y, area.h, scaleY, ky);
      // The source span the columns read, and where each tap falls in it.
      const fx0 = clampX(cols.first[0]!);
      const fx1 = clampX(cols.first[area.w - 1]! + cols.taps - 1);
      const span = fx1 - fx0 + 1;
      const index = new Int32Array(area.w * cols.taps);
      for (let i = 0; i < area.w; i++)
        for (let k = 0; k < cols.taps; k++) index[i * cols.taps + k] = clampX(cols.first[i]! + k) - fx0;
      const y0 = rows.first[0]!;
      const y1 = rows.first[area.h - 1]! + rows.taps - 1;

      const rowPixels = new Float32Array(span * spp);
      const prem = new Float32Array(span * stride);
      const h = new Float32Array((y1 - y0 + 1) * area.w * stride);
      for (let sy = y0; sy <= y1; sy++) {
        read.row(clampY(sy), fx0, span, rowPixels, 0);
        for (let i = 0; i < span; i++) {
          const a = format.hasAlpha ? rowPixels[i * spp + cc]! / max : 1;
          for (let c = 0; c < cc; c++) prem[i * stride + c] = rowPixels[i * spp + c]! * a;
          prem[i * stride + cc] = a;
        }
        const rowOffset = (sy - y0) * area.w * stride;
        for (let i = 0; i < area.w; i++) {
          const o = rowOffset + i * stride;
          const t0 = i * cols.taps;
          if (stride === 4) {
            // RGB / Lab + alpha: the common case, unrolled.
            let s0 = 0;
            let s1 = 0;
            let s2 = 0;
            let s3 = 0;
            for (let k = 0; k < cols.taps; k++) {
              const w = cols.weights[t0 + k]!;
              const s = index[t0 + k]! * 4;
              s0 += w * prem[s]!;
              s1 += w * prem[s + 1]!;
              s2 += w * prem[s + 2]!;
              s3 += w * prem[s + 3]!;
            }
            h[o] = s0;
            h[o + 1] = s1;
            h[o + 2] = s2;
            h[o + 3] = s3;
            continue;
          }
          for (let k = 0; k < cols.taps; k++) {
            const w = cols.weights[t0 + k]!;
            if (w === 0) continue;
            const s = index[t0 + k]! * stride;
            for (let c = 0; c < stride; c++) h[o + c]! += w * prem[s + c]!;
          }
        }
      }

      const data = newTile(format, allocate);
      const whole = area.w === TILE_SIZE && area.h === TILE_SIZE;
      if (fill && !format.hasAlpha && !whole) fillRun(data, 0, TILE_SIZE * TILE_SIZE, fill, spp);
      for (let j = 0; j < area.h; j++) {
        const first = rows.first[j]! - y0;
        for (let i = 0; i < area.w; i++) {
          acc.fill(0);
          for (let k = 0; k < rows.taps; k++) {
            const w = rows.weights[j * rows.taps + k]!;
            if (w === 0) continue;
            const s = ((first + k) * area.w + i) * stride;
            for (let c = 0; c < stride; c++) acc[c]! += w * h[s + c]!;
          }
          const a = acc[cc]!;
          const o = ((area.y - ty * TILE_SIZE + j) * TILE_SIZE + (area.x - tx * TILE_SIZE + i)) * spp;
          for (let c = 0; c < cc; c++) data[o + c] = q(a > 1e-9 ? acc[c]! / a : 0);
          if (format.hasAlpha) {
            const alpha = Math.min(1, Math.max(0, a));
            data[o + cc] = format.depth === 32 ? alpha : Math.round(alpha * max);
          }
        }
      }
      if (!tileIsBlank(data, format, fill)) tiles.push({ tx, ty, data });
    }
  }
  return tiles;
}
