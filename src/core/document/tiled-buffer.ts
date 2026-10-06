/**
 * A sparse, unbounded grid of copy-on-write tiles holding one layer's pixels.
 *
 * - Tiles are allocated lazily: a missing tile reads as `defaultPixel` everywhere
 *   (transparent for layers, the background colour for a Background layer).
 * - Coordinates are in the buffer's own pixel space and may be negative, so a
 *   layer can hold pixels outside the canvas (as the reference app does).
 * - Writes go through `writableTile`, which copies frozen tiles first; frozen
 *   tiles captured by the history therefore never change underneath it.
 */
import { intersectRects, isEmptyRect, unionRects, EMPTY_RECT, type Rect } from './geometry';
import { copySamples, createSampleArray, samplesPerPixel, type PixelFormat, type SampleArray } from './pixel-format';
import {
  TILE_SIZE,
  allocateTile,
  copyTile,
  fillPixels,
  heapTileMemory,
  tileCoordsFromKey,
  tileIndex,
  tileKey,
  TileNotResidentError,
  type Tile,
  type TileMemory,
} from './tile';

export type TileChangeListener = (tx: number, ty: number) => void;

export interface TiledBufferOptions {
  memory?: TileMemory;
  /** Value of every pixel in an unallocated tile (default: all zeros, i.e. transparent). */
  defaultPixel?: ArrayLike<number>;
}

export class TiledBuffer {
  readonly format: PixelFormat;
  /** Interleaved samples per pixel. */
  readonly spp: number;
  readonly memory: TileMemory;
  readonly defaultPixel: readonly number[];
  readonly #tiles = new Map<number, Tile>();
  readonly #listeners = new Set<TileChangeListener>();
  #defaultRow: SampleArray | undefined;
  /** True while the buffer belongs to a layer of an open document (see Tile.attachedRefs). */
  #attached = false;

  constructor(format: PixelFormat, options: TiledBufferOptions = {}) {
    this.format = format;
    this.spp = samplesPerPixel(format);
    this.memory = options.memory ?? heapTileMemory;
    const pixel = Array.from({ length: this.spp }, (_, i) => options.defaultPixel?.[i] ?? 0);
    this.defaultPixel = Object.freeze(pixel);
  }

  get tileCount(): number {
    return this.#tiles.size;
  }

  /** The tile at tile coordinates (tx, ty), or undefined if it reads as `defaultPixel`. */
  getTile(tx: number, ty: number): Tile | undefined {
    return this.#tiles.get(tileKey(tx, ty));
  }

  /**
   * Returns a tile that may be written, allocating it (filled with `defaultPixel`)
   * or replacing a frozen tile with a private copy. Reports the tile as changed.
   */
  writableTile(tx: number, ty: number): Tile {
    const key = tileKey(tx, ty);
    let tile = this.#tiles.get(key);
    if (!tile) {
      tile = allocateTile(this.format, this.memory, this.defaultPixel);
      this.#put(key, tile);
    } else if (tile.frozen) {
      tile = copyTile(tile, this.format, this.memory);
      this.#put(key, tile);
    }
    tile.touch();
    this.#notify(tx, ty);
    return tile;
  }

  /**
   * Freezes and returns the current tile so it can be kept (e.g. as undo data).
   * Returns undefined for an unallocated tile.
   */
  captureTile(tx: number, ty: number): Tile | undefined {
    return this.#tiles.get(tileKey(tx, ty))?.freeze();
  }

  /** Puts a (frozen) tile in place, or removes the tile when `tile` is undefined. Used by undo/redo. */
  setTile(tx: number, ty: number, tile: Tile | undefined): void {
    const key = tileKey(tx, ty);
    if (tile) {
      if (tile.length !== TILE_SIZE * TILE_SIZE * this.spp || tile.depth !== this.format.depth) {
        throw new Error('setTile: tile format mismatch');
      }
      if (this.#attached && !tile.resident) throw new TileNotResidentError(tile.id);
      this.#put(key, tile.freeze());
    } else {
      this.#put(key, undefined);
    }
    this.#notify(tx, ty);
  }

  /** Reports a tile as changed without touching it (e.g. after a worker wrote into it). */
  markChanged(tx: number, ty: number): void {
    const tile = this.getTile(tx, ty);
    if (tile && !tile.frozen) tile.touch();
    this.#notify(tx, ty);
  }

  /** Iterates allocated tiles as [tx, ty, tile]. */
  *tiles(): IterableIterator<[number, number, Tile]> {
    for (const [key, tile] of this.#tiles) {
      const [tx, ty] = tileCoordsFromKey(key);
      yield [tx, ty, tile];
    }
  }

  /** Pixel rectangle covered by allocated tiles (tile-aligned), or an empty rect. */
  tileBounds(): Rect {
    let bounds = EMPTY_RECT;
    for (const [tx, ty] of this.tiles()) {
      bounds = unionRects(bounds, { x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE });
    }
    return bounds;
  }

  /** Reads one pixel's samples. */
  getPixel(x: number, y: number, out: number[] = new Array<number>(this.spp)): number[] {
    const tx = tileIndex(x);
    const ty = tileIndex(y);
    const tile = this.getTile(tx, ty);
    if (!tile) {
      for (let c = 0; c < this.spp; c++) out[c] = this.defaultPixel[c]!;
      return out;
    }
    const offset = ((y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE)) * this.spp;
    for (let c = 0; c < this.spp; c++) out[c] = tile.data[offset + c]!;
    return out;
  }

  /** Copies a rectangle into a new (or the given) interleaved sample array of r.w × r.h pixels. */
  readRegion(r: Rect, out?: SampleArray): SampleArray {
    const length = r.w * r.h * this.spp;
    const dst = out ?? createSampleArray(this.format.depth, length);
    this.#checkArray(dst, length, 'readRegion');
    this.#forEachTileSpan(r, (tile, srcOffset, dstOffset, samples) => {
      const src = tile ? tile.data.subarray(srcOffset, srcOffset + samples) : this.#defaults(samples);
      copySamples(dst, src, dstOffset);
    });
    return dst;
  }

  /** Writes an interleaved r.w × r.h sample array into the buffer. */
  writeRegion(r: Rect, src: SampleArray): void {
    this.#checkArray(src, r.w * r.h * this.spp, 'writeRegion');
    let current: { tx: number; ty: number; tile: Tile } | undefined;
    this.#forEachTileSpan(r, (_tile, tileOffset, srcOffset, samples, tx, ty) => {
      if (!current || current.tx !== tx || current.ty !== ty) current = { tx, ty, tile: this.writableTile(tx, ty) };
      copySamples(current.tile.data, src.subarray(srcOffset, srcOffset + samples), tileOffset);
    });
  }

  /** A new buffer sharing all tiles (frozen), so later writes to either side stay separate. */
  clone(): TiledBuffer {
    const copy = new TiledBuffer(this.format, { memory: this.memory, defaultPixel: this.defaultPixel });
    for (const [key, tile] of this.#tiles) copy.#tiles.set(key, tile.freeze());
    return copy;
  }

  get attached(): boolean {
    return this.#attached;
  }

  /**
   * Marks the buffer as part of an open document. Its tiles then count as in use
   * and are never moved out of memory. Every tile must be resident.
   */
  attach(): void {
    if (this.#attached) return;
    for (const tile of this.#tiles.values()) if (!tile.resident) throw new TileNotResidentError(tile.id);
    this.#attached = true;
    for (const tile of this.#tiles.values()) tile.adjustAttachedRefs(1);
  }

  detach(): void {
    if (!this.#attached) return;
    this.#attached = false;
    for (const tile of this.#tiles.values()) tile.adjustAttachedRefs(-1);
  }

  onTileChange(listener: TileChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #put(key: number, tile: Tile | undefined): void {
    const old = this.#tiles.get(key);
    if (old === tile) return;
    if (this.#attached) {
      old?.adjustAttachedRefs(-1);
      tile?.adjustAttachedRefs(1);
    }
    if (tile) this.#tiles.set(key, tile);
    else this.#tiles.delete(key);
  }

  #notify(tx: number, ty: number): void {
    for (const listener of this.#listeners) listener(tx, ty);
  }

  /** Calls `fn` for every row segment of `r`, tile by tile, with sample offsets into tile and region. */
  #forEachTileSpan(
    r: Rect,
    fn: (
      tile: Tile | undefined,
      tileOffset: number,
      regionOffset: number,
      samples: number,
      tx: number,
      ty: number,
    ) => void,
  ): void {
    if (isEmptyRect(r)) return;
    const spp = this.spp;
    for (let ty = tileIndex(r.y); ty <= tileIndex(r.y + r.h - 1); ty++) {
      for (let tx = tileIndex(r.x); tx <= tileIndex(r.x + r.w - 1); tx++) {
        const span = intersectRects(r, { x: tx * TILE_SIZE, y: ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE });
        const tile = this.getTile(tx, ty);
        const samples = span.w * spp;
        for (let y = span.y; y < span.y + span.h; y++) {
          const tileOffset = ((y - ty * TILE_SIZE) * TILE_SIZE + (span.x - tx * TILE_SIZE)) * spp;
          const regionOffset = ((y - r.y) * r.w + (span.x - r.x)) * spp;
          fn(tile, tileOffset, regionOffset, samples, tx, ty);
        }
      }
    }
  }

  /** A run of `samples` default-pixel samples (at most one tile row). */
  #defaults(samples: number): SampleArray {
    if (!this.#defaultRow) {
      this.#defaultRow = createSampleArray(this.format.depth, TILE_SIZE * this.spp);
      fillPixels(this.#defaultRow, this.defaultPixel, this.spp);
    }
    return this.#defaultRow.subarray(0, samples);
  }

  #checkArray(array: SampleArray, length: number, op: string): void {
    const expected = this.format.depth === 8 ? Uint8Array : this.format.depth === 16 ? Uint16Array : Float32Array;
    if (!(array instanceof expected)) throw new Error(`${op}: expected ${expected.name} for ${this.format.depth}-bit`);
    if (array.length !== length) throw new Error(`${op}: expected ${length} samples, got ${array.length}`);
  }
}
