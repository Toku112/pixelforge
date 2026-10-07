/**
 * Free Transform's pixel work (runs in the pixel worker).
 *
 * Every output pixel looks up where it comes from through the inverse transform and
 * samples the source there with the chosen interpolation, on premultiplied colour
 * (FORMAT_NOTES §6). Where the transform shrinks the image, the filter is widened to
 * the output pixel's footprint (as in Image Size), so detail does not alias.
 *
 * - `transformLayerPixels` moves a whole layer: the result replaces it.
 * - `transformSelectedPixels` moves only the selected pixels of a layer: they are
 *   lifted (as much as the selection covers them), their old place becomes
 *   transparent — or the background colour where alpha cannot change — and they are
 *   laid down transformed over what is there.
 * - `transformMask` moves the selection itself.
 *
 * Speed: the inverse transform is stepped along each output row, source pixels are
 * read as small blocks, and output pixels whose source lies outside the layer are
 * skipped.
 */
import { intersectRects, isEmptyRect, unionRects, type Rect } from '../document/geometry';
import {
  createSampleArray,
  maxSampleValue,
  samplesPerPixel,
  type PixelFormat,
  type SampleArray,
} from '../document/pixel-format';
import { TILE_PIXELS, TILE_SIZE, tileIndex, tileKey } from '../document/tile';
import { MaskReader } from '../selection/mask-ops';
import type { MaskData } from '../selection/selection';
import { resampleKernel, type Allocator, type LayerTile, type ResampleMethod } from './layer-geometry';
import type { Mat3 } from './transform';

export interface TransformPixelsSetup {
  format: PixelFormat;
  /** Value of layer pixels in tiles not passed as sources. */
  defaultPixel: readonly number[];
  /** The layer's position in the document. */
  offsetX: number;
  offsetY: number;
  /** Document point after → document point before (the inverse of the transform). */
  inverse: Mat3;
  method: ResampleMethod;
  /** Only the selected pixels move (null: the whole layer). */
  mask: MaskData | null;
  canvas: Rect;
  /** Colour samples left behind where alpha cannot change; null for transparency. */
  fill: number[] | null;
  /** Live previews: sample every `draftStep`-th pixel per axis and repeat it (default 1: every pixel). */
  draftStep?: number;
}

type TileRef = { tx: number; ty: number; data: SampleArray };

const heap: Allocator = (n) => new ArrayBuffer(n);
/** The widest a shrinking filter grows (source pixels per output pixel). */
const MAX_STRETCH = 6;

/** Selection values by document pixel (0 outside the canvas). */
class MaskLookup {
  readonly #tiles = new Map<number, Uint8Array>();
  readonly #mask: MaskData;
  readonly #canvas: Rect;

  constructor(mask: MaskData, canvas: Rect) {
    this.#mask = mask;
    this.#canvas = canvas;
    for (const t of mask.tiles) this.#tiles.set(tileKey(t.tx, t.ty), t.data);
  }

  value(x: number, y: number): number {
    const c = this.#canvas;
    if (x < c.x || y < c.y || x >= c.x + c.w || y >= c.y + c.h) return 0;
    const mx = x - this.#mask.offsetX;
    const my = y - this.#mask.offsetY;
    const tx = tileIndex(mx);
    const ty = tileIndex(my);
    const t = this.#tiles.get(tileKey(tx, ty));
    return t ? t[(my - ty * TILE_SIZE) * TILE_SIZE + (mx - tx * TILE_SIZE)]! : this.#mask.fill;
  }

  /** Where anything is selected (tile-aligned, within the canvas). */
  bounds(): Rect {
    const m = this.#mask;
    if (m.fill !== 0) return this.#canvas;
    let r: Rect = { x: 0, y: 0, w: 0, h: 0 };
    for (const t of m.tiles)
      r = unionRects(r, {
        x: t.tx * TILE_SIZE + m.offsetX,
        y: t.ty * TILE_SIZE + m.offsetY,
        w: TILE_SIZE,
        h: TILE_SIZE,
      });
    return intersectRects(r, this.#canvas);
  }
}

/** Premultiplied source pixels (document coordinates), selection applied, read in blocks. */
class Source {
  readonly #tiles = new Map<number, SampleArray>();
  readonly #setup: TransformPixelsSetup;
  readonly #mask: MaskLookup | null;
  readonly #spp: number;
  readonly #cc: number;
  readonly #max: number;
  // One-tile cache: neighbouring reads nearly always share a tile.
  #key = Number.NaN;
  #data: SampleArray | undefined;
  /** Where the source can be non-transparent (document coordinates). */
  readonly bounds: Rect;

  constructor(setup: TransformPixelsSetup, sources: TileRef[]) {
    this.#setup = setup;
    this.#spp = samplesPerPixel(setup.format);
    this.#cc = setup.format.colorChannels;
    this.#max = maxSampleValue(setup.format.depth);
    for (const s of sources) this.#tiles.set(tileKey(s.tx, s.ty), s.data);
    this.#mask = setup.mask ? new MaskLookup(setup.mask, setup.canvas) : null;
    let b: Rect = { x: 0, y: 0, w: 0, h: 0 };
    const defaultShows = !setup.format.hasAlpha || setup.defaultPixel[this.#cc] !== 0;
    if (defaultShows) b = { x: -1e9, y: -1e9, w: 2e9, h: 2e9 };
    else
      for (const s of sources)
        b = unionRects(b, {
          x: s.tx * TILE_SIZE + setup.offsetX,
          y: s.ty * TILE_SIZE + setup.offsetY,
          w: TILE_SIZE,
          h: TILE_SIZE,
        });
    this.bounds = this.#mask ? intersectRects(b, this.#mask.bounds()) : b;
  }

  /** Pixels (i0 … i0 + kx − 1, j0 … j0 + ky − 1) into `out`, row by row: colour × alpha, then alpha (0–1). */
  block(i0: number, j0: number, kx: number, ky: number, out: Float64Array): void {
    const { offsetX, offsetY, defaultPixel, format } = this.#setup;
    const spp = this.#spp;
    const cc = this.#cc;
    const stride = cc + 1;
    const max = this.#max;
    const mask = this.#mask;
    for (let j = 0; j < ky; j++) {
      const y = j0 + j;
      const ly = y - offsetY;
      const ty = tileIndex(ly);
      const rowBase = (ly - ty * TILE_SIZE) * TILE_SIZE;
      for (let i = 0; i < kx;) {
        const lx = i0 + i - offsetX;
        const tx = tileIndex(lx);
        const start = lx - tx * TILE_SIZE;
        const run = Math.min(TILE_SIZE - start, kx - i);
        const key = tileKey(tx, ty);
        if (key !== this.#key) {
          this.#key = key;
          this.#data = this.#tiles.get(key);
        }
        const data = this.#data;
        for (let r = 0; r < run; r++) {
          const o = (j * kx + i + r) * stride;
          let a: number;
          if (data) {
            const s = (rowBase + start + r) * spp;
            a = format.hasAlpha ? data[s + cc]! / max : 1;
            if (mask) a *= mask.value(i0 + i + r, y) / 255;
            for (let c = 0; c < cc; c++) out[o + c] = data[s + c]! * a;
          } else {
            a = format.hasAlpha ? defaultPixel[cc]! / max : 1;
            if (mask) a *= mask.value(i0 + i + r, y) / 255;
            for (let c = 0; c < cc; c++) out[o + c] = defaultPixel[c]! * a;
          }
          out[o + cc] = a;
        }
        i += run;
      }
    }
  }
}

/** Fills `acc` (premultiplied colour, alpha) with the transformed source along output row `y`, pixel by pixel. */
function makeRowSampler(setup: TransformPixelsSetup, source: Source) {
  const [a, b, c, d, e, f, g, h, k] = setup.inverse;
  const affine = Math.abs(g) < 1e-12 && Math.abs(h) < 1e-12;
  const cc = setup.format.colorChannels;
  const stride = cc + 1;
  const sb = source.bounds;
  const wx = new Float64Array(64);
  const wy = new Float64Array(64);
  let block = new Float64Array(64 * stride);
  const kernels = new Map<ResampleMethod, NonNullable<ReturnType<typeof resampleKernel>>>();
  const kernelOf = (m: ResampleMethod) => {
    let kn = kernels.get(m);
    if (!kn) kernels.set(m, (kn = resampleKernel(m, 1)!));
    return kn;
  };

  /**
   * Samples output pixels x0, x0 + step, … (< x1) of row y; `emit(x)` receives each
   * with its value in `acc` (alpha 0 = nothing arrives there).
   */
  return (y: number, x0: number, x1: number, acc: Float64Array, emit: (x: number) => void, step = 1): void => {
    const cx = x0 + 0.5;
    const cy = y + 0.5;
    let U = a * cx + b * cy + c;
    let V = d * cx + e * cy + f;
    let W = g * cx + h * cy + k;
    const sa = a * step;
    const sd = d * step;
    const sg = g * step;
    for (let x = x0; x < x1; x += step, U += sa, V += sd, W += sg) {
      acc.fill(0);
      if (W <= 1e-12) {
        emit(x);
        continue;
      }
      const u = U / W - 0.5; // source position in pixel-index space
      const v = V / W - 0.5;
      // How far one output pixel reaches in the source, along the source axes.
      let dux = a;
      let dvx = d;
      let duy = b;
      let dvy = e;
      if (!affine) {
        dux = (a - (u + 0.5) * g) / W;
        dvx = (d - (v + 0.5) * g) / W;
        duy = (b - (u + 0.5) * h) / W;
        dvy = (e - (v + 0.5) * h) / W;
      }
      // Widen the filter only where the image shrinks (a turn alone must stay sharp).
      const ex = Math.min(MAX_STRETCH, Math.max(1, Math.hypot(dux, duy)));
      const ey = Math.min(MAX_STRETCH, Math.max(1, Math.hypot(dvx, dvy)));
      const method = setup.method;
      if (method === 'nearest') {
        const i = Math.floor(u + 0.5);
        const j = Math.floor(v + 0.5);
        if (i >= sb.x && j >= sb.y && i < sb.x + sb.w && j < sb.y + sb.h) {
          source.block(i, j, 1, 1, block);
          for (let ch = 0; ch < stride; ch++) acc[ch] = block[ch]!;
        }
        emit(x);
        continue;
      }
      // Automatic: smoother when enlarging, sharper when shrinking, the exact bicubic at the same size.
      const scale = 1 / Math.max(Math.hypot(dux, dvx), Math.hypot(duy, dvy), 1e-9);
      const chosen: ResampleMethod =
        method !== 'automatic'
          ? method
          : scale > 1.01
            ? 'bicubic-smoother'
            : scale < 0.99
              ? 'bicubic-sharper'
              : 'bicubic';
      const kernel = kernelOf(chosen);
      const rx = kernel.radius * ex;
      const ry = kernel.radius * ey;
      // Unstretched: exactly 2 (bilinear) or 4 (bicubic) taps per axis.
      const i0 = ex === 1 ? Math.floor(u) - kernel.radius + 1 : Math.ceil(u - rx);
      const i1 = ex === 1 ? Math.floor(u) + kernel.radius : Math.floor(u + rx);
      const j0 = ey === 1 ? Math.floor(v) - kernel.radius + 1 : Math.ceil(v - ry);
      const j1 = ey === 1 ? Math.floor(v) + kernel.radius : Math.floor(v + ry);
      if (i1 < sb.x || j1 < sb.y || i0 >= sb.x + sb.w || j0 >= sb.y + sb.h) {
        emit(x); // nothing of the source reaches here
        continue;
      }
      const kx = i1 - i0 + 1;
      const ky = j1 - j0 + 1;
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < kx; i++) sx += wx[i] = kernel.weight((i0 + i - u) / ex);
      for (let j = 0; j < ky; j++) sy += wy[j] = kernel.weight((j0 + j - v) / ey);
      if (sx === 0 || sy === 0) {
        emit(x);
        continue;
      }
      if (block.length < kx * ky * stride) block = new Float64Array(kx * ky * stride);
      source.block(i0, j0, kx, ky, block);
      for (let j = 0; j < ky; j++) {
        const wj = wy[j]! / sy;
        if (wj === 0) continue;
        for (let i = 0; i < kx; i++) {
          const w = (wx[i]! / sx) * wj;
          if (w === 0) continue;
          const o = (j * kx + i) * stride;
          for (let ch = 0; ch < stride; ch++) acc[ch]! += w * block[o + ch]!;
        }
      }
      emit(x);
    }
  };
}

/** Writes premultiplied `acc` (alpha 0–1) as samples, alone or over a base pixel. */
function makeWriter(format: PixelFormat) {
  const cc = format.colorChannels;
  const max = maxSampleValue(format.depth);
  const float = format.depth === 32;
  const q = (v: number) => (float ? v : Math.round(v < 0 ? 0 : v > max ? max : v));
  return (
    out: SampleArray,
    o: number,
    acc: Float64Array,
    base: readonly number[] | null,
    baseAlpha: number,
    alphaFixed: boolean,
  ): void => {
    const pa = Math.min(1, Math.max(0, acc[cc]!));
    if (alphaFixed) {
      // Alpha stays as it was (no alpha, or locked transparency): only the colour mixes.
      for (let c = 0; c < cc; c++) out[o + c] = q(base![c]! * (1 - pa) + acc[c]!);
      if (format.hasAlpha) out[o + cc] = q(baseAlpha * max);
      return;
    }
    const ba = base ? baseAlpha : 0;
    const alpha = pa + ba * (1 - pa);
    for (let c = 0; c < cc; c++) {
      const under = base ? base[c]! * ba * (1 - pa) : 0;
      out[o + c] = q(alpha > 1e-9 ? (acc[c]! + under) / alpha : 0);
    }
    out[o + cc] = float ? alpha : Math.round(Math.min(1, alpha) * max);
  };
}

/** Whether output area `r` can receive anything from source area `bounds` (with a filter margin). */
function reaches(inverse: Mat3, r: Rect, bounds: Rect): boolean {
  const [a, b, c, d, e, f, g, h, k] = inverse;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ] as const) {
    const w = g * px + h * py + k;
    if (w <= 1e-12) return true; // past the horizon: be safe
    const u = (a * px + b * py + c) / w;
    const v = (d * px + e * py + f) / w;
    x0 = Math.min(x0, u);
    y0 = Math.min(y0, v);
    x1 = Math.max(x1, u);
    y1 = Math.max(y1, v);
  }
  const m = 2 * MAX_STRETCH + 2;
  return x1 + m >= bounds.x && y1 + m >= bounds.y && x0 - m <= bounds.x + bounds.w && y0 - m <= bounds.y + bounds.h;
}

/**
 * A whole layer transformed: new tiles on the document grid (the layer then sits at
 * offset 0, 0) covering `area` (document), fully transparent tiles left out.
 */
export function transformLayerPixels(
  setup: TransformPixelsSetup,
  sources: TileRef[],
  area: Rect,
  allocate: Allocator = heap,
): LayerTile[] {
  const format = setup.format;
  const spp = samplesPerPixel(format);
  const cc = format.colorChannels;
  const bytes = format.depth === 8 ? 1 : format.depth === 16 ? 2 : 4;
  const source = new Source(setup, sources);
  const sampleRow = makeRowSampler(setup, source);
  const write = makeWriter(format);
  const acc = new Float64Array(cc + 1);
  const step = Math.max(1, Math.floor(setup.draftStep ?? 1));
  const tiles: LayerTile[] = [];
  if (isEmptyRect(area)) return tiles;
  for (let ty = tileIndex(area.y); ty <= tileIndex(area.y + area.h - 1); ty++) {
    for (let tx = tileIndex(area.x); tx <= tileIndex(area.x + area.w - 1); tx++) {
      const r = intersectRects({ x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE }, area);
      if (isEmptyRect(r) || !reaches(setup.inverse, r, source.bounds)) continue;
      const data = createSampleArray(format.depth, TILE_PIXELS * spp, allocate(TILE_PIXELS * spp * bytes));
      let empty = true;
      if (step === 1) {
        for (let y = r.y; y < r.y + r.h; y++) {
          const rowBase = (y - ty * TILE_SIZE) * TILE_SIZE - tx * TILE_SIZE;
          sampleRow(y, r.x, r.x + r.w, acc, (x) => {
            if (acc[cc]! <= 0) return;
            const o = (rowBase + x) * spp;
            write(data, o, acc, null, 0, false);
            if (data[o + cc] !== 0) empty = false;
          });
        }
      } else {
        // Draft: one sample per step × step block (on the document grid, so blocks stay put).
        const first = (n: number) => Math.floor(n / step) * step;
        for (let by = first(r.y); by < r.y + r.h; by += step) {
          sampleRow(
            by,
            first(r.x),
            r.x + r.w,
            acc,
            (bx) => {
              if (acc[cc]! <= 0) return;
              for (let y = Math.max(by, r.y); y < Math.min(by + step, r.y + r.h); y++) {
                for (let x = Math.max(bx, r.x); x < Math.min(bx + step, r.x + r.w); x++) {
                  const o = ((y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE)) * spp;
                  write(data, o, acc, null, 0, false);
                  if (data[o + cc] !== 0) empty = false;
                }
              }
            },
            step,
          );
        }
      }
      if (!empty) tiles.push({ tx, ty, data });
    }
  }
  return tiles;
}

/** Computes `outputs` (layer tile coordinates) from the unchanged `sources`: the selected pixels transformed. */
export function transformSelectedPixels(setup: TransformPixelsSetup, sources: TileRef[], outputs: TileRef[]): void {
  const format = setup.format;
  const spp = samplesPerPixel(format);
  const cc = format.colorChannels;
  const max = maxSampleValue(format.depth);
  const alphaFixed = !format.hasAlpha || setup.fill !== null;
  const src = new Map<number, SampleArray>();
  for (const s of sources) src.set(tileKey(s.tx, s.ty), s.data);
  const sampleRow = makeRowSampler(setup, new Source(setup, sources));
  const write = makeWriter(format);
  const reader = setup.mask ? new MaskReader(setup.mask) : null;
  const acc = new Float64Array(cc + 1);
  const base = new Array<number>(spp).fill(0);

  for (const out of outputs) {
    const original = src.get(tileKey(out.tx, out.ty));
    const here = reader ? reader.layerTile(setup.canvas, setup.offsetX, setup.offsetY, out.tx, out.ty) : 255;
    for (let py = 0; py < TILE_SIZE; py++) {
      const ly = out.ty * TILE_SIZE + py;
      const x0 = out.tx * TILE_SIZE + setup.offsetX;
      sampleRow(ly + setup.offsetY, x0, x0 + TILE_SIZE, acc, (x) => {
        const p = py * TILE_SIZE + (x - x0);
        const o = p * spp;
        // What stays: the original, emptied (or filled) where it was selected.
        for (let c = 0; c < spp; c++) base[c] = original ? original[o + c]! : setup.defaultPixel[c]!;
        const m0 = here === 0 ? 0 : here === 255 ? 1 : here[p]! / 255;
        let baseAlpha = format.hasAlpha ? base[cc]! / max : 1;
        if (setup.fill) for (let c = 0; c < cc; c++) base[c]! += (setup.fill[c]! - base[c]!) * m0;
        else baseAlpha *= 1 - m0;
        // What arrives: the lifted pixels, transformed.
        write(out.data, o, acc, base, baseAlpha, alphaFixed);
      });
    }
  }
}

/** The selection after the transform (bilinear, so edges stay smooth); null when nothing is left on the canvas. */
export function transformMask(mask: MaskData, inverse: Mat3, area: Rect, canvas: Rect): MaskData | null {
  const lookup = new MaskLookup(mask, canvas);
  const [a, b, c, d, e, f, g, h, k] = inverse;
  const r = intersectRects(area, canvas);
  const out: { tx: number; ty: number; data: Uint8Array }[] = [];
  if (isEmptyRect(r)) return null;
  for (let ty = tileIndex(r.y); ty <= tileIndex(r.y + r.h - 1); ty++) {
    for (let tx = tileIndex(r.x); tx <= tileIndex(r.x + r.w - 1); tx++) {
      const part = intersectRects({ x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE }, r);
      if (isEmptyRect(part)) continue;
      const data = new Uint8Array(TILE_PIXELS);
      let empty = true;
      for (let y = part.y; y < part.y + part.h; y++) {
        const cx = part.x + 0.5;
        const cy = y + 0.5;
        let U = a * cx + b * cy + c;
        let V = d * cx + e * cy + f;
        let W = g * cx + h * cy + k;
        for (let x = part.x; x < part.x + part.w; x++, U += a, V += d, W += g) {
          if (W <= 1e-12) continue;
          const u = U / W - 0.5;
          const v = V / W - 0.5;
          const i = Math.floor(u);
          const j = Math.floor(v);
          const fx = u - i;
          const fy = v - j;
          const m =
            lookup.value(i, j) * (1 - fx) * (1 - fy) +
            lookup.value(i + 1, j) * fx * (1 - fy) +
            lookup.value(i, j + 1) * (1 - fx) * fy +
            lookup.value(i + 1, j + 1) * fx * fy;
          const q = Math.round(m);
          if (q === 0) continue;
          data[(y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE)] = q;
          empty = false;
        }
      }
      if (!empty) out.push({ tx, ty, data });
    }
  }
  return out.length === 0 ? null : { tiles: out, fill: 0, offsetX: 0, offsetY: 0 };
}
