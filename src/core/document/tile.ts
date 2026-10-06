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
}

export const heapTileMemory: TileMemory = {
  allocate: (byteLength) => new ArrayBuffer(byteLength),
};

let nextTileId = 1;

export class Tile {
  /** Unique id, useful for caches keyed by tile identity (e.g. GPU textures). */
  readonly id = nextTileId++;
  readonly data: SampleArray;
  #frozen = false;

  constructor(data: SampleArray) {
    this.data = data;
  }

  /** True once the tile may be referenced elsewhere; frozen tiles must not be written. */
  get frozen(): boolean {
    return this.#frozen;
  }

  freeze(): this {
    this.#frozen = true;
    return this;
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
  return new Tile(data);
}

/** Allocates a writable copy of `source`. */
export function copyTile(source: Tile, format: PixelFormat, memory: TileMemory): Tile {
  const data = createSampleArray(format.depth, source.data.length, memory.allocate(tileByteLength(format)));
  copySamples(data, source.data);
  return new Tile(data);
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
