/**
 * Renders brush and eraser strokes into layer tiles (runs in the pixel worker).
 *
 * Every touched tile keeps a copy of its pixels from before the stroke and a
 * coverage buffer. Each dab adds `flow × strength × profile` to the coverage
 * (building up: c ← c + (1 − c)·a), and the pixel is recomputed from its original
 * value with the stroke's coverage limited by Opacity and the selection — so one
 * stroke never exceeds Opacity however often it crosses itself, as in the
 * reference app.
 *
 * - Brush: paints the colour over the pixel (with locked transparency, or on a
 *   layer without alpha, only the colour changes).
 * - Eraser: lowers alpha; on a layer without alpha or with locked transparency it
 *   paints the background colour instead.
 */
import type { Rect } from '../document/geometry';
import { maxSampleValue, samplesPerPixel, type PixelFormat, type SampleArray } from '../document/pixel-format';
import { TILE_SIZE, tileIndex, tileKey } from '../document/tile';
import { MaskReader } from '../selection/mask-ops';
import type { MaskData } from '../selection/selection';
import { dabBounds, dabCoverage, type Dab } from './brush';

export interface StrokeSetup {
  format: PixelFormat;
  /** Colour samples painted (the brush colour, or the background colour for erasing opaque layers). */
  color: number[];
  erase: boolean;
  opacity: number;
  flow: number;
  hardness: number;
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
  /** Selection under the tile: per-pixel values, or uniform 0 / 255. */
  selection: Uint8Array | 0 | 255;
}

export class StrokeRenderer {
  readonly #setup: StrokeSetup;
  readonly #tiles = new Map<number, TileState>();
  readonly #reader: MaskReader | null;
  readonly #spp: number;
  readonly #max: number;

  constructor(setup: StrokeSetup) {
    this.#setup = setup;
    this.#spp = samplesPerPixel(setup.format);
    this.#max = maxSampleValue(setup.format.depth);
    this.#reader = setup.selection ? new MaskReader(setup.selection.mask) : null;
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
      selection: this.#reader ? this.#reader.layerTile(s.selection!.canvas, s.offsetX, s.offsetY, tx, ty) : 255,
    });
  }

  /** Paints dabs (document coordinates). Returns the keys of the tiles that changed. */
  applyDabs(dabs: readonly Dab[]): Set<number> {
    const changed = new Set<number>();
    const s = this.#setup;
    for (const dab of dabs) {
      const b = dabBounds(dab);
      // In layer coordinates.
      const lx0 = b.x - s.offsetX;
      const ly0 = b.y - s.offsetY;
      const r = dab.size / 2;
      const amount = Math.min(1, s.flow * dab.strength);
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
              const cov = dabCoverage(Math.hypot(lx + s.offsetX + 0.5 - dab.x, dy), r, s.hardness);
              if (cov <= 0) continue;
              const p = (ly - ty * TILE_SIZE) * TILE_SIZE + (lx - tx * TILE_SIZE);
              const c = tile.coverage[p]!;
              tile.coverage[p] = c + (1 - c) * cov * amount;
              this.#shade(tile, p);
              any = true;
            }
          }
          if (any) changed.add(tileKey(tx, ty));
        }
      }
    }
    return changed;
  }

  /** Recomputes one pixel from its original value and the stroke's coverage. */
  #shade(tile: TileState, p: number): void {
    const s = this.#setup;
    const sel = tile.selection === 255 ? 1 : (tile.selection as Uint8Array)[p]! / 255;
    const e = s.opacity * tile.coverage[p]! * sel;
    const cc = s.format.colorChannels;
    const spp = this.#spp;
    const max = this.#max;
    const i = p * spp;
    const o = tile.original;
    const out = tile.data;
    const q = s.format.depth === 32 ? (v: number) => v : (v: number) => Math.round(Math.min(max, Math.max(0, v)));
    const hasAlpha = s.format.hasAlpha;
    const keepAlpha = !hasAlpha || s.lockAlpha;
    if (s.erase && !keepAlpha) {
      out[i + cc] = q(o[i + cc]! * (1 - e));
      return;
    }
    if (keepAlpha) {
      // Only the colour changes (Background, locked transparency, or the eraser painting the background colour).
      for (let c = 0; c < cc; c++) out[i + c] = q(o[i + c]! + (s.color[c]! - o[i + c]!) * e);
      return;
    }
    // Paint over the pixel ("over" with straight alpha).
    const ao = o[i + cc]! / max;
    const a = e + ao * (1 - e);
    for (let c = 0; c < cc; c++) {
      out[i + c] = a > 0 ? q((s.color[c]! * e + o[i + c]! * ao * (1 - e)) / a) : o[i + c]!;
    }
    out[i + cc] = q(a * max);
  }

  /** The current data of tiles by key (for returning edited copies). */
  tile(key: number): { tx: number; ty: number; data: SampleArray } | undefined {
    const t = this.#tiles.get(key);
    return t && { tx: t.tx, ty: t.ty, data: t.data };
  }
}

/** Layer tiles (layer tile coordinates) the dabs touch. */
export function dabTiles(dabs: readonly Dab[], offsetX: number, offsetY: number): [number, number][] {
  const out = new Map<number, [number, number]>();
  for (const dab of dabs) {
    const b = dabBounds(dab);
    const x0 = b.x - offsetX;
    const y0 = b.y - offsetY;
    for (let ty = tileIndex(y0); ty <= tileIndex(y0 + b.h - 1); ty++)
      for (let tx = tileIndex(x0); tx <= tileIndex(x0 + b.w - 1); tx++) out.set(tileKey(tx, ty), [tx, ty]);
  }
  return [...out.values()];
}
