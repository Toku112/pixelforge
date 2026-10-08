/**
 * Renders brush and eraser strokes into layer tiles (runs in the pixel worker).
 *
 * Every touched tile keeps a copy of its pixels from before the stroke and a
 * coverage buffer. Each dab adds `flow × strength × tip` to the coverage
 * (building up: c ← c + (1 − c)·a), and the pixel is recomputed from its original
 * value with the stroke's coverage limited by Opacity and the selection — so one
 * stroke never exceeds Opacity however often it crosses itself, as in the
 * reference app.
 *
 * - Brush: paints the colour into the pixel with the brush Mode (a blend mode,
 *   computed like a layer of paint over the pixel; Behind paints under existing
 *   pixels; Clear erases). With locked transparency, or on a layer without alpha,
 *   only the colour changes.
 * - Eraser: lowers alpha; on a layer without alpha or with locked transparency it
 *   paints the background colour instead.
 * - Tips: the computed round/elliptical tip, or a sampled tip read bilinearly from
 *   a pyramid of halved copies (so small dabs of a large tip stay smooth).
 */
import { blendChannel, blendColor, dissolveNoise, isWholeColorMode } from '../composite/blend';
import type { Rect } from '../document/geometry';
import { maxSampleValue, samplesPerPixel, type PixelFormat, type SampleArray } from '../document/pixel-format';
import { TILE_SIZE, tileIndex, tileKey } from '../document/tile';
import { MaskReader } from '../selection/mask-ops';
import type { MaskData } from '../selection/selection';
import { dabBounds, dabCoverage, type BrushMode, type Dab } from './brush';

export interface StrokeSetup {
  format: PixelFormat;
  /** Colour samples painted (the brush colour, or the background colour for erasing opaque layers). */
  color: number[];
  erase: boolean;
  opacity: number;
  flow: number;
  hardness: number;
  /** How paint combines with the pixels (brush only). */
  mode: BrushMode;
  /** A sampled tip (coverage 0–255), or null for the computed round tip. */
  tip: { width: number; height: number; data: Uint8Array } | null;
  /** Dabs carry their own colours (Color Dynamics) / opacities (Transfer): keep them per pixel. */
  varyColor?: boolean;
  varyOpacity?: boolean;
  /** Transparency of the layer is locked: alpha never changes. */
  lockAlpha: boolean;
  /** The layer's position in the document. */
  offsetX: number;
  offsetY: number;
  /** Painting is limited to the selection, when there is one. */
  selection: { mask: MaskData; canvas: Rect } | null;
}

interface TileState {
  tx: number;
  ty: number;
  data: SampleArray;
  original: SampleArray;
  coverage: Float32Array;
  /** Colour of the paint so far per pixel (varied colours only). */
  paint: Float32Array | null;
  /** Highest dab opacity that reached each pixel (varied opacities only). */
  cap: Float32Array | null;
  /** Selection under the tile: per-pixel values, or uniform 0 / 255. */
  selection: Uint8Array | 0 | 255;
}

/** A sampled tip as a pyramid: level 0 is the tip (0–1), each next level half the size. */
interface TipPyramid {
  levels: { w: number; h: number; data: Float32Array }[];
  /** The tip's longer side at level 0. */
  side: number;
}

function buildPyramid(tip: { width: number; height: number; data: Uint8Array }): TipPyramid {
  const first = new Float32Array(tip.width * tip.height);
  for (let i = 0; i < first.length; i++) first[i] = tip.data[i]! / 255;
  const levels = [{ w: tip.width, h: tip.height, data: first }];
  for (;;) {
    const prev = levels.at(-1)!;
    if (prev.w <= 2 && prev.h <= 2) break;
    const w = Math.max(1, Math.ceil(prev.w / 2));
    const h = Math.max(1, Math.ceil(prev.h / 2));
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const sx = x * 2 + dx;
            const sy = y * 2 + dy;
            if (sx < prev.w && sy < prev.h) {
              sum += prev.data[sy * prev.w + sx]!;
              n++;
            }
          }
        data[y * w + x] = sum / n;
      }
    }
    levels.push({ w, h, data });
  }
  return { levels, side: Math.max(tip.width, tip.height) };
}

/** Bilinear sample of a pyramid level at (u, v) in level pixels (centres at +0.5); 0 outside. */
function sampleLevel(level: { w: number; h: number; data: Float32Array }, u: number, v: number): number {
  const x = u - 0.5;
  const y = v - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (i: number, j: number) =>
    i < 0 || j < 0 || i >= level.w || j >= level.h ? 0 : level.data[j * level.w + i]!;
  return (
    at(x0, y0) * (1 - fx) * (1 - fy) +
    at(x0 + 1, y0) * fx * (1 - fy) +
    at(x0, y0 + 1) * (1 - fx) * fy +
    at(x0 + 1, y0 + 1) * fx * fy
  );
}

export class StrokeRenderer {
  readonly #setup: StrokeSetup;
  readonly #tiles = new Map<number, TileState>();
  readonly #reader: MaskReader | null;
  readonly #spp: number;
  readonly #max: number;
  readonly #tip: TipPyramid | null;
  readonly #q: (v: number) => number;
  readonly #hdr: boolean;
  /** Scratch: the blended paint colour of the pixel being shaded. */
  readonly #blended = [0, 0, 0, 0];
  readonly #paintScratch = [0, 0, 0, 0];

  constructor(setup: StrokeSetup) {
    this.#setup = setup;
    this.#spp = samplesPerPixel(setup.format);
    this.#max = maxSampleValue(setup.format.depth);
    this.#reader = setup.selection ? new MaskReader(setup.selection.mask) : null;
    this.#tip = setup.tip ? buildPyramid(setup.tip) : null;
    const max = this.#max;
    this.#hdr = setup.format.depth === 32;
    this.#q = this.#hdr ? (v) => v : (v) => Math.round(Math.min(max, Math.max(0, v)));
  }

  hasTile(tx: number, ty: number): boolean {
    return this.#tiles.has(tileKey(tx, ty));
  }

  /** Adds a layer tile (layer tile coordinates) the stroke may paint into; `data` is written in place. */
  addTile(tx: number, ty: number, data: SampleArray): void {
    const key = tileKey(tx, ty);
    if (this.#tiles.has(key)) return;
    const s = this.#setup;
    this.#tiles.set(key, {
      tx,
      ty,
      data,
      original: data.slice(),
      coverage: new Float32Array(TILE_SIZE * TILE_SIZE),
      paint: s.varyColor ? new Float32Array(TILE_SIZE * TILE_SIZE * s.format.colorChannels) : null,
      cap: s.varyOpacity ? new Float32Array(TILE_SIZE * TILE_SIZE) : null,
      selection: this.#reader ? this.#reader.layerTile(s.selection!.canvas, s.offsetX, s.offsetY, tx, ty) : 255,
    });
  }

  /** The tip's coverage (0–1) at offset (dx, dy) from a dab's centre (document px). */
  #coverage(dab: Dab, cos: number, sin: number, level: number, scale: number, dx: number, dy: number): number {
    let u = dx * cos - dy * sin;
    let v = dx * sin + dy * cos;
    if (dab.flipX) u = -u;
    if (dab.flipY) v = -v;
    v /= dab.roundness;
    const tip = this.#tip;
    if (!tip) return dabCoverage(Math.hypot(u, v), dab.size / 2, this.#setup.hardness);
    // Document px → tip px at level 0, then at the chosen level.
    const lv = tip.levels[level]!;
    const f = 2 ** level;
    const t0 = tip.levels[0]!;
    return sampleLevel(lv, (u / scale + t0.w / 2) / f, (v / scale + t0.h / 2) / f);
  }

  /** Paints dabs (document coordinates). Returns the keys of the tiles that changed. */
  applyDabs(dabs: readonly Dab[]): Set<number> {
    const changed = new Set<number>();
    const s = this.#setup;
    const tip = this.#tip;
    for (const dab of dabs) {
      const b = dabBounds(dab, tip !== null);
      // In layer coordinates.
      const lx0 = b.x - s.offsetX;
      const ly0 = b.y - s.offsetY;
      const amount = Math.min(1, s.flow * dab.strength);
      const a = (dab.angle * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      // Sampled tips: document px per tip px, and the pyramid level that is about one tip px per document px.
      const scale = tip ? dab.size / tip.side : 1;
      const level = tip ? Math.min(tip.levels.length - 1, Math.max(0, Math.floor(Math.log2(1 / scale)))) : 0;
      for (let ty = tileIndex(ly0); ty <= tileIndex(ly0 + b.h - 1); ty++) {
        for (let tx = tileIndex(lx0); tx <= tileIndex(lx0 + b.w - 1); tx++) {
          const tile = this.#tiles.get(tileKey(tx, ty));
          if (!tile || tile.selection === 0) continue;
          const x0 = Math.max(lx0, tx * TILE_SIZE);
          const y0 = Math.max(ly0, ty * TILE_SIZE);
          const x1 = Math.min(lx0 + b.w, (tx + 1) * TILE_SIZE);
          const y1 = Math.min(ly0 + b.h, (ty + 1) * TILE_SIZE);
          let any = false;
          for (let ly = y0; ly < y1; ly++) {
            const dy = ly + s.offsetY + 0.5 - dab.y;
            for (let lx = x0; lx < x1; lx++) {
              const cov = this.#coverage(dab, cos, sin, level, scale, lx + s.offsetX + 0.5 - dab.x, dy);
              if (cov <= 0) continue;
              const p = (ly - ty * TILE_SIZE) * TILE_SIZE + (lx - tx * TILE_SIZE);
              const c = tile.coverage[p]!;
              const add = cov * amount;
              const next = c + (1 - c) * add;
              if (tile.paint) {
                // New paint over the paint so far.
                const cc = s.format.colorChannels;
                const color = dab.color ?? s.color;
                for (let k = 0; k < cc; k++) {
                  const old = tile.paint[p * cc + k]!;
                  tile.paint[p * cc + k] = next > 0 ? (old * c * (1 - add) + color[k]! * add) / next : color[k]!;
                }
              }
              if (tile.cap) tile.cap[p] = Math.max(tile.cap[p]!, dab.opacity ?? s.opacity);
              tile.coverage[p] = next;
              this.#shade(tile, p, lx + s.offsetX, ly + s.offsetY);
              any = true;
            }
          }
          if (any) changed.add(tileKey(tx, ty));
        }
      }
    }
    return changed;
  }

  /** Recomputes one pixel (document position x, y) from its original value and the stroke's coverage. */
  #shade(tile: TileState, p: number, x: number, y: number): void {
    const s = this.#setup;
    const sel = tile.selection === 255 ? 1 : (tile.selection as Uint8Array)[p]! / 255;
    let e = (tile.cap ? tile.cap[p]! : s.opacity) * tile.coverage[p]! * sel;
    const cc = s.format.colorChannels;
    const color = tile.paint ? this.#paintColor(tile.paint, p, cc) : s.color;
    const max = this.#max;
    const q = this.#q;
    const i = p * this.#spp;
    const o = tile.original;
    const out = tile.data;
    const keepAlpha = !s.format.hasAlpha || s.lockAlpha;
    const mode = s.erase ? 'erase' : s.mode;
    if (mode === 'erase' || mode === 'clear') {
      if (keepAlpha) {
        // The eraser paints the background colour where alpha cannot change; Clear does nothing there.
        if (mode === 'erase') for (let c = 0; c < cc; c++) out[i + c] = q(o[i + c]! + (color[c]! - o[i + c]!) * e);
        return;
      }
      out[i + cc] = q(o[i + cc]! * (1 - e));
      return;
    }
    if (mode === 'dissolve') e = dissolveNoise(x, y) < e ? 1 : 0;
    const ao = keepAlpha ? 1 : o[i + cc]! / max;
    if (mode === 'behind') {
      // Paint under the pixel: the pixel over the paint.
      if (keepAlpha) return;
      const a = ao + e * (1 - ao);
      for (let c = 0; c < cc; c++) out[i + c] = a > 0 ? q((o[i + c]! * ao + color[c]! * e * (1 - ao)) / a) : o[i + c]!;
      out[i + cc] = q(a * max);
      return;
    }
    // The paint's colour blended with the pixel (as a layer of paint over it).
    const blended = this.#blended;
    if (mode === 'normal' || mode === 'dissolve') {
      for (let c = 0; c < cc; c++) blended[c] = color[c]!;
    } else if (isWholeColorMode(mode) && cc === 3) {
      const b = [o[i]! / max, o[i + 1]! / max, o[i + 2]! / max];
      const src = [color[0]! / max, color[1]! / max, color[2]! / max];
      const r = blendColor(mode, b, src, this.#hdr);
      for (let c = 0; c < 3; c++) blended[c] = r[c]! * max;
    } else {
      for (let c = 0; c < cc; c++)
        blended[c] = blendChannel(mode, o[i + c]! / max, color[c]! / max, 1, this.#hdr) * max;
    }
    if (keepAlpha) {
      for (let c = 0; c < cc; c++) out[i + c] = q(o[i + c]! + (blended[c]! - o[i + c]!) * e);
      return;
    }
    // Paint over the pixel: where the pixel is transparent the paint shows as is; elsewhere the blend.
    const a = e + ao * (1 - e);
    for (let c = 0; c < cc; c++) {
      const v = (1 - ao) * e * color[c]! + ao * e * blended[c]! + (1 - e) * ao * o[i + c]!;
      out[i + c] = a > 0 ? q(v / a) : o[i + c]!;
    }
    out[i + cc] = q(a * max);
  }

  /** The paint colour at pixel p (scratch array, valid until the next call). */
  #paintColor(paint: Float32Array, p: number, cc: number): number[] {
    const out = this.#paintScratch;
    for (let k = 0; k < cc; k++) out[k] = paint[p * cc + k]!;
    return out;
  }

  /** The current data of tiles by key (for returning edited copies). */
  tile(key: number): { tx: number; ty: number; data: SampleArray } | undefined {
    const t = this.#tiles.get(key);
    return t && { tx: t.tx, ty: t.ty, data: t.data };
  }
}

/** Layer tiles (layer tile coordinates) the dabs touch. */
export function dabTiles(dabs: readonly Dab[], offsetX: number, offsetY: number, sampled = false): [number, number][] {
  const out = new Map<number, [number, number]>();
  for (const dab of dabs) {
    const b = dabBounds(dab, sampled);
    const x0 = b.x - offsetX;
    const y0 = b.y - offsetY;
    for (let ty = tileIndex(y0); ty <= tileIndex(y0 + b.h - 1); ty++)
      for (let tx = tileIndex(x0); tx <= tileIndex(x0 + b.w - 1); tx++) out.set(tileKey(tx, ty), [tx, ty]);
  }
  return [...out.values()];
}
