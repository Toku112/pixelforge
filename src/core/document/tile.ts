/**
 * Tiles: fixed-size 256×256 blocks of interleaved pixel samples.
 *
 * Tiles are copy-on-write. Once a tile is frozen (captured by the undo history or
 * shared between buffers) it is never modified again; a buffer that wants to write
 * to it first replaces it with a private copy. This makes undo snapshots and layer
 * duplication cost only the tiles that actually change.
 */
import {
  bytesPerSample,
  copySamples,
  createSampleArray,
  samplesPerPixel,
  type BitDepth,
  type PixelFormat,
  type SampleArray,
} from './pixel-format';

export const TILE_SIZE = 256;
export const TILE_PIXELS = TILE_SIZE * TILE_SIZE;

/**
 * Supplies the memory behind tiles. The default uses ordinary ArrayBuffers; the
 * engine provides a SharedArrayBuffer-backed allocator (so workers can process
 * tiles without copying) with a memory budget.
 */
export interface TileMemory {
  /** Must return zero-filled memory of exactly `byteLength` bytes. */
  allocate(byteLength: number): ArrayBuffer | SharedArrayBuffer;
  /** Called for every new tile, so a memory manager can account for it and later evict it. */
  track?(tile: Tile): void;
}

export const heapTileMemory: TileMemory = {
  allocate: (byteLength) => new ArrayBuffer(byteLength),
};

/**
 * Makes tiles whose pixel memory was moved to disk (by the engine's tile store)
 * resident again. The default implementation does nothing: without a store,
 * every tile is always resident.
 */
export interface TileResidency {
  ensureResident(tiles: Iterable<Tile>): Promise<void>;
}

export const alwaysResident: TileResidency = {
  ensureResident: () => Promise.resolve(),
};

export class TileNotResidentError extends Error {
  override readonly name = 'TileNotResidentError';
  constructor(id: number) {
    super(`Tile ${id} is not in memory; call ensureResident() first`);
  }
}

let nextTileId = 1;

export class Tile {
  /** Unique id, useful for caches keyed by tile identity (e.g. GPU textures). */
  readonly id = nextTileId++;
  readonly depth: BitDepth;
  /** Number of samples. */
  readonly length: number;
  readonly byteLength: number;
  #data: SampleArray | null;
  #frozen = false;
  #attachedRefs = 0;
  #version = 0;

  constructor(data: SampleArray) {
    this.#data = data;
    this.length = data.length;
    this.byteLength = data.byteLength;
    this.depth = data instanceof Uint8Array ? 8 : data instanceof Uint16Array ? 16 : 32;
  }

  /** The pixel samples. Throws `TileNotResidentError` if the memory was moved to disk. */
  get data(): SampleArray {
    if (!this.#data) throw new TileNotResidentError(this.id);
    return this.#data;
  }

  get resident(): boolean {
    return this.#data !== null;
  }

  /** True once the tile may be referenced elsewhere; frozen tiles must not be written. */
  get frozen(): boolean {
    return this.#frozen;
  }

  freeze(): this {
    this.#frozen = true;
    return this;
  }

  /**
   * Increases whenever the tile's samples may have changed (writable tiles are
   * edited in place), so caches such as GPU textures know to refresh.
   */
  get version(): number {
    return this.#version;
  }

  /** Marks the samples as (possibly) changed. Frozen tiles never change. */
  touch(): void {
    if (this.#frozen) throw new Error(`Tile ${this.id} is frozen and cannot change`);
    this.#version++;
  }

  /** How many buffers of open documents currently hold this tile. */
  get attachedRefs(): number {
    return this.#attachedRefs;
  }

  /** Bookkeeping for TiledBuffer. */
  adjustAttachedRefs(delta: 1 | -1): void {
    this.#attachedRefs += delta;
    if (this.#attachedRefs < 0) throw new Error(`Tile ${this.id}: attached reference count below zero`);
  }

  /**
   * Drops the pixel memory after the tile store saved it elsewhere. Only frozen tiles
   * that no open document holds may be released.
   */
  release(): void {
    if (!this.#frozen || this.#attachedRefs > 0) throw new Error(`Tile ${this.id} is in use and cannot be released`);
    this.#data = null;
  }

  /** Gives a released tile its pixel memory back (filled by the caller). */
  restore(buffer: ArrayBuffer | SharedArrayBuffer): SampleArray {
    if (this.#data) throw new Error(`Tile ${this.id} is already resident`);
    if (buffer.byteLength !== this.byteLength) throw new Error(`Tile ${this.id}: restore size mismatch`);
    this.#data = createSampleArray(this.depth, this.length, buffer);
    return this.#data;
  }
}

export function tileByteLength(format: PixelFormat): number {
  return TILE_PIXELS * samplesPerPixel(format) * bytesPerSample(format.depth);
}

/** Allocates a tile filled with `pixel` (one value per interleaved sample). */
export function allocateTile(format: PixelFormat, memory: TileMemory, pixel: ArrayLike<number>): Tile {
  const spp = samplesPerPixel(format);
  const data = createSampleArray(format.depth, TILE_PIXELS * spp, memory.allocate(tileByteLength(format)));
  if (!isZeroPixel(pixel)) fillPixels(data, pixel, spp); // fresh memory is already zero
  const tile = new Tile(data);
  memory.track?.(tile);
  return tile;
}

/**
 * Wraps sample data produced elsewhere (e.g. a decoder in a worker) as a tile,
 * registering it with the memory manager. `data` must be a whole tile.
 */
export function adoptTile(data: SampleArray, format: PixelFormat, memory: TileMemory): Tile {
  if (data.length !== TILE_PIXELS * samplesPerPixel(format)) throw new Error('adoptTile: data is not a whole tile');
  const tile = new Tile(data);
  if (tile.depth !== format.depth) throw new Error('adoptTile: sample type does not match the format');
  memory.track?.(tile);
  return tile;
}

/** Allocates a writable copy of `source`. */
export function copyTile(source: Tile, format: PixelFormat, memory: TileMemory): Tile {
  const data = createSampleArray(format.depth, source.data.length, memory.allocate(tileByteLength(format)));
  copySamples(data, source.data);
  const tile = new Tile(data);
  memory.track?.(tile);
  return tile;
}

/** Fills `data` (a whole number of pixels) with a repeating pixel of `spp` samples. */
export function fillPixels(data: SampleArray, pixel: ArrayLike<number>, spp: number): void {
  if (data.length === 0) return;
  for (let c = 0; c < spp; c++) data[c] = pixel[c] ?? 0;
  // Doubling copy: fills the array in O(log n) copyWithin() calls.
  let filled = spp;
  while (filled < data.length) {
    const n = Math.min(filled, data.length - filled);
    data.copyWithin(filled, 0, n);
    filled += n;
  }
}

export function isZeroPixel(pixel: ArrayLike<number>): boolean {
  for (let i = 0; i < pixel.length; i++) if (pixel[i] !== 0) return false;
  return true;
}

// Tile keys pack signed tile coordinates into one safe integer (fast Map keys).
const KEY_OFFSET = 1 << 20; // supports ±1,048,576 tiles (≈ ±268 million pixels) per axis
const KEY_SPAN = 1 << 21;

export function tileKey(tx: number, ty: number): number {
  return (tx + KEY_OFFSET) * KEY_SPAN + (ty + KEY_OFFSET);
}

export function tileCoordsFromKey(key: number): [tx: number, ty: number] {
  const tx = Math.floor(key / KEY_SPAN) - KEY_OFFSET;
  const ty = (key % KEY_SPAN) - KEY_OFFSET;
  return [tx, ty];
}

/** Tile index containing pixel coordinate `v` (works for negative coordinates). */
export function tileIndex(v: number): number {
  return Math.floor(v / TILE_SIZE);
}
