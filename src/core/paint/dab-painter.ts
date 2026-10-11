/**
 * What painters share whose every dab works on what the dabs before it left (the Mixer
 * Brush, Smudge, Blur and Sharpen; core/paint/mixer.ts and retouch.ts), unlike the
 * brush's painter, which recomputes each pixel from before the stroke (stroke.ts):
 *
 * - the layer tiles the stroke may change (written in place), with the selection under
 *   each and, for Sample All Layers, the image under the layer there (composited from a
 *   flatten plan when the tile is added);
 * - pixels read and written as premultiplied values 0–1 (colour may exceed 1 in 32-bit),
 *   keeping alpha where it may not change (locked transparency, no alpha channel);
 * - the canvas a dab takes paint from: the layer, or the layer at its opacity × fill over
 *   the image under it;
 * - the tip's coverage at a pixel (DabShape);
 * - only the canvas: pixels a layer has outside it are neither read nor changed (the
 *   Background's beyond its edge would otherwise be smeared in).
 */
import { flatten, type FlattenPlan } from '../composite/flatten';
import { maxSampleValue, samplesPerPixel, type SampleArray } from '../document/pixel-format';
import { TILE_SIZE, tileIndex, tileKey } from '../document/tile';
import { MaskReader } from '../selection/mask-ops';
import { dabCoverage, type Dab } from './brush';
import { buildPyramid, tipCoverage, tipScale, type StrokeSetup, type TipPyramid } from './stroke';

export interface DabTile {
  tx: number;
  ty: number;
  data: SampleArray;
  /** The selection under the tile: per-pixel values, or uniform 0 / 255. */
  selection: Uint8Array | 0 | 255;
  /** Sample All Layers: the image under the layer at this tile (premultiplied, colour + alpha per pixel). */
  below: Float32Array | null;
}

export abstract class DabPainter {
  protected readonly setup: StrokeSetup;
  protected readonly tiles = new Map<number, DabTile>();
  protected readonly tip: TipPyramid | null;
  /** Colour channels, and values per premultiplied pixel (colour + alpha). */
  protected readonly cc: number;
  protected readonly n: number;
  /** Samples per layer pixel. */
  protected readonly spp: number;
  protected readonly max: number;
  /** A value 0–max as a sample (rounded and clamped below 32-bit). */
  protected readonly q: (v: number) => number;
  readonly #reader: MaskReader | null;
  readonly #below: FlattenPlan | null;
  readonly #layerOpacity: number;

  /** `below`: Sample All Layers' image under the layer (null: the layer only), drawn with `layerOpacity` over it. */
  constructor(setup: StrokeSetup, below: FlattenPlan | null, layerOpacity: number) {
    this.setup = setup;
    this.cc = setup.format.colorChannels;
    this.n = this.cc + 1;
    this.spp = samplesPerPixel(setup.format);
    this.max = maxSampleValue(setup.format.depth);
    const max = this.max;
    this.q = setup.format.depth === 32 ? (v) => v : (v) => Math.round(Math.min(max, Math.max(0, v)));
    this.#reader = setup.selection ? new MaskReader(setup.selection.mask) : null;
    this.tip = setup.tip ? buildPyramid(setup.tip) : null;
    this.#below = below;
    this.#layerOpacity = layerOpacity;
  }

  hasTile(tx: number, ty: number): boolean {
    return this.tiles.has(tileKey(tx, ty));
  }

  /** Adds a layer tile (layer tile coordinates) the stroke may paint into; `data` is written in place. */
  addTile(tx: number, ty: number, data: SampleArray): void {
    const key = tileKey(tx, ty);
    if (this.tiles.has(key)) return;
    const s = this.setup;
    const below = this.#below;
    this.tiles.set(key, {
      tx,
      ty,
      data,
      selection: this.#reader ? this.#reader.layerTile(s.selection!.canvas, s.offsetX, s.offsetY, tx, ty) : 255,
      below: below
        ? flatten(below, { x: tx * TILE_SIZE + s.offsetX, y: ty * TILE_SIZE + s.offsetY, w: TILE_SIZE, h: TILE_SIZE })
            .data
        : null,
    });
  }

  tile(key: number): { tx: number; ty: number; data: SampleArray } | undefined {
    const t = this.tiles.get(key);
    return t && { tx: t.tx, ty: t.ty, data: t.data };
  }

  /** Paints dabs (document coordinates) in order. Returns the keys of the tiles that changed. */
  abstract applyDabs(dabs: readonly Dab[]): Set<number>;

  /** The tile holding layer pixel (lx, ly) and the pixel's index in it, or null where the stroke has no tile. */
  protected tileAt(lx: number, ly: number): { tile: DabTile; p: number } | null {
    const tx = tileIndex(lx);
    const ty = tileIndex(ly);
    const tile = this.tiles.get(tileKey(tx, ty));
    return tile ? { tile, p: (ly - ty * TILE_SIZE) * TILE_SIZE + (lx - tx * TILE_SIZE) } : null;
  }

  /** The layer pixel at sample index `i` of `data`, premultiplied 0–1, into `out`. */
  protected read(data: SampleArray, i: number, out: Float32Array): void {
    const cc = this.cc;
    const a = this.setup.format.hasAlpha ? data[i + cc]! / this.max : 1;
    for (let c = 0; c < cc; c++) out[c] = (data[i + c]! / this.max) * a;
    out[cc] = a;
  }

  /** The canvas paint at pixel `p` of a tile: the layer pixel, or with Sample All Layers the layer over the image under it. */
  protected canvasAt(layer: Float32Array, below: Float32Array | null, p: number, out: Float32Array): void {
    const n = this.n;
    if (!below) {
      out.set(layer);
      return;
    }
    const op = this.#layerOpacity;
    const keep = 1 - layer[n - 1]! * op;
    for (let c = 0; c < n; c++) out[c] = layer[c]! * op + below[p * n + c]! * keep;
  }

  /** Writes premultiplied paint `px` to the layer pixel at sample index `i` (alpha kept where it may not change). */
  protected write(tile: DabTile, i: number, px: Float32Array, alphaBefore: number): void {
    const s = this.setup;
    const cc = this.cc;
    const max = this.max;
    const q = this.q;
    const out = tile.data;
    const a = px[cc]!;
    if (a <= 1e-7) {
      if (s.format.hasAlpha && !s.lockAlpha) out[i + cc] = 0;
      return;
    }
    for (let c = 0; c < cc; c++) out[i + c] = q((px[c]! / a) * max);
    if (s.format.hasAlpha && !s.lockAlpha) out[i + cc] = q(a * max);
    else if (s.format.hasAlpha) out[i + cc] = q(alphaBefore * max);
  }

  /** The selection's value (0–1) at pixel `p` of a tile. */
  protected selected(tile: DabTile, p: number): number {
    return tile.selection === 255 ? 1 : tile.selection === 0 ? 0 : tile.selection[p]! / 255;
  }

  /** Whether document pixel (x, y) is on the canvas. */
  protected inCanvas(x: number, y: number): boolean {
    const c = this.setup.canvas;
    return !c || (x >= c.x && y >= c.y && x < c.x + c.w && y < c.y + c.h);
  }

  /** The tip's shape for a dab. */
  protected shape(dab: Dab): DabShape {
    return new DabShape(dab, this.tip, this.setup.hardness, this.setup.aliased === true);
  }
}

/** A dab's tip: its coverage (0–1) at an offset from its centre; the round tip worked out directly. */
export class DabShape {
  readonly #dab: Dab;
  readonly #tip: TipPyramid | null;
  readonly #hardness: number;
  readonly #aliased: boolean;
  readonly #cos: number;
  readonly #sin: number;
  readonly #scale: number;
  readonly #level: number;
  readonly #radius: number;
  /** Squared distance beyond which the round tip covers nothing. */
  readonly #reach: number;

  constructor(dab: Dab, tip: TipPyramid | null, hardness: number, aliased: boolean) {
    this.#dab = dab;
    this.#tip = tip;
    this.#hardness = hardness;
    this.#aliased = aliased;
    const a = (dab.angle * Math.PI) / 180;
    this.#cos = Math.cos(a);
    this.#sin = Math.sin(a);
    const { scale, level } = tipScale(dab, tip);
    this.#scale = scale;
    this.#level = level;
    this.#radius = dab.size / 2;
    this.#reach = (this.#radius + 0.5) ** 2;
  }

  /** Coverage at offset (dx, dy) from the dab's centre (document px). */
  at(dx: number, dy: number): number {
    const d = this.#dab;
    if (this.#tip)
      return tipCoverage(
        d,
        this.#tip,
        this.#hardness,
        this.#aliased,
        this.#cos,
        this.#sin,
        this.#level,
        this.#scale,
        dx,
        dy,
      );
    // Round or elliptical: most pixels of its square are quick to skip.
    const u = dx * this.#cos - dy * this.#sin;
    const v = (dx * this.#sin + dy * this.#cos) / d.roundness;
    const d2 = u * u + v * v;
    if (d2 >= this.#reach) return 0;
    const dist = Math.sqrt(d2);
    return this.#aliased ? (dist <= this.#radius ? 1 : 0) : dabCoverage(dist, this.#radius, this.#hardness);
  }
}
