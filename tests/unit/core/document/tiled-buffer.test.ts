import { describe, expect, it } from 'vitest';
import type { PixelFormat } from '../../../../src/core/document/pixel-format';
import { TILE_SIZE, tileCoordsFromKey, tileIndex, tileKey, type TileMemory } from '../../../../src/core/document/tile';
import { TiledBuffer } from '../../../../src/core/document/tiled-buffer';

const RGBA8: PixelFormat = { depth: 8, colorChannels: 3, hasAlpha: true };
const RGBA16: PixelFormat = { depth: 16, colorChannels: 3, hasAlpha: true };
const RGBA32: PixelFormat = { depth: 32, colorChannels: 3, hasAlpha: true };
const RGB8: PixelFormat = { depth: 8, colorChannels: 3, hasAlpha: false };

/** A deterministic r.w × r.h RGBA8 pattern. */
function pattern(w: number, h: number, seed = 0): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i++) out[i] = (i * 7 + seed) % 256;
  return out;
}

describe('tile keys and indices', () => {
  it('round-trip signed tile coordinates', () => {
    for (const [tx, ty] of [
      [0, 0],
      [-1, -1],
      [5, -3],
      [-1000, 1000],
      [1048575, -1048576],
    ] as const) {
      expect(tileCoordsFromKey(tileKey(tx, ty))).toEqual([tx, ty]);
    }
  });

  it('floors negative pixel coordinates to the correct tile', () => {
    expect(tileIndex(0)).toBe(0);
    expect(tileIndex(255)).toBe(0);
    expect(tileIndex(256)).toBe(1);
    expect(tileIndex(-1)).toBe(-1);
    expect(tileIndex(-256)).toBe(-1);
    expect(tileIndex(-257)).toBe(-2);
  });
});

describe('TiledBuffer', () => {
  it('reads unallocated areas as the default pixel without allocating', () => {
    const transparent = new TiledBuffer(RGBA8);
    expect(transparent.getPixel(10, 10)).toEqual([0, 0, 0, 0]);
    const white = new TiledBuffer(RGB8, { defaultPixel: [255, 255, 255] });
    expect(white.getPixel(-5000, 7000)).toEqual([255, 255, 255]);
    expect([...white.readRegion({ x: 250, y: 0, w: 10, h: 2 })]).toEqual(new Array(60).fill(255));
    expect(white.tileCount).toBe(0);
  });

  it('round-trips regions that span tile boundaries, including negative coordinates', () => {
    const buf = new TiledBuffer(RGBA8);
    const r = { x: -300, y: 200, w: 700, h: 120 };
    const src = pattern(r.w, r.h);
    buf.writeRegion(r, src);
    expect(buf.readRegion(r)).toEqual(src);
    // Tiles touched: x from -2..1, y 0..1 → 4 × 2.
    expect(buf.tileCount).toBe(8);
    expect(buf.tileBounds()).toEqual({ x: -512, y: 0, w: 1024, h: 512 });
    // A pixel check against the source layout.
    const px = buf.getPixel(-300 + 5, 200 + 3);
    const i = (3 * r.w + 5) * 4;
    expect(px).toEqual([...src.subarray(i, i + 4)]);
  });

  it('fills newly allocated tiles with the default pixel around written areas', () => {
    const buf = new TiledBuffer(RGB8, { defaultPixel: [10, 20, 30] });
    buf.writeRegion({ x: 100, y: 100, w: 1, h: 1 }, new Uint8Array([1, 2, 3]));
    expect(buf.getPixel(100, 100)).toEqual([1, 2, 3]);
    expect(buf.getPixel(101, 100)).toEqual([10, 20, 30]);
    expect(buf.getPixel(0, 0)).toEqual([10, 20, 30]);
  });

  it('supports 16-bit and 32-bit float samples', () => {
    const b16 = new TiledBuffer(RGBA16);
    b16.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint16Array([65535, 32768, 1, 40000]));
    expect(b16.getPixel(0, 0)).toEqual([65535, 32768, 1, 40000]);

    const b32 = new TiledBuffer(RGBA32);
    b32.writeRegion({ x: 300, y: 0, w: 1, h: 1 }, new Float32Array([4.5, -0.25, 0.5, 1]));
    expect(b32.getPixel(300, 0)).toEqual([4.5, -0.25, 0.5, 1]);
    expect(b32.readRegion({ x: 300, y: 0, w: 1, h: 1 })).toBeInstanceOf(Float32Array);
  });

  it('rejects arrays of the wrong type or length', () => {
    const buf = new TiledBuffer(RGBA16);
    expect(() => buf.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array(4))).toThrow('expected Uint16Array');
    expect(() => buf.writeRegion({ x: 0, y: 0, w: 2, h: 1 }, new Uint16Array(4))).toThrow('expected 8 samples');
  });

  it('never modifies a captured (frozen) tile: writes go to a copy', () => {
    const buf = new TiledBuffer(RGBA8);
    buf.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([1, 1, 1, 255]));
    const captured = buf.captureTile(0, 0)!;
    expect(captured.frozen).toBe(true);

    const writable = buf.writableTile(0, 0);
    expect(writable).not.toBe(captured);
    writable.data[0] = 99;
    expect(captured.data[0]).toBe(1);
    expect(buf.getPixel(0, 0)[0]).toBe(99);
    // Further writes reuse the private copy.
    expect(buf.writableTile(0, 0)).toBe(writable);
  });

  it('restores captured tiles and removes tiles with setTile', () => {
    const buf = new TiledBuffer(RGBA8);
    buf.writeRegion({ x: 0, y: 0, w: 2, h: 1 }, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const before = buf.captureTile(0, 0);
    buf.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([9, 9, 9, 9]));
    buf.setTile(0, 0, before);
    expect(buf.getPixel(0, 0)).toEqual([1, 2, 3, 4]);
    buf.setTile(0, 0, undefined);
    expect(buf.tileCount).toBe(0);
    expect(buf.getPixel(0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('clones by sharing tiles, keeping later writes separate', () => {
    const a = new TiledBuffer(RGBA8);
    a.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([5, 5, 5, 5]));
    const b = a.clone();
    expect(b.getTile(0, 0)).toBe(a.getTile(0, 0));
    b.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([7, 7, 7, 7]));
    a.writeRegion({ x: 1, y: 0, w: 1, h: 1 }, new Uint8Array([8, 8, 8, 8]));
    expect(a.getPixel(0, 0)).toEqual([5, 5, 5, 5]);
    expect(b.getPixel(0, 0)).toEqual([7, 7, 7, 7]);
    expect(b.getPixel(1, 0)).toEqual([0, 0, 0, 0]);
  });

  it('reports changed tiles to listeners', () => {
    const buf = new TiledBuffer(RGBA8);
    const seen: string[] = [];
    const off = buf.onTileChange((tx, ty) => seen.push(`${tx},${ty}`));
    buf.writeRegion({ x: 250, y: -10, w: 10, h: 20 }, pattern(10, 20));
    expect(seen.sort()).toEqual(['0,-1', '0,0', '1,-1', '1,0']);
    off();
    buf.markChanged(3, 3);
    expect(seen).toHaveLength(4);
  });

  it('allocates tile memory through the injected allocator', () => {
    const sizes: number[] = [];
    const memory: TileMemory = {
      allocate: (n) => {
        sizes.push(n);
        return new ArrayBuffer(n);
      },
    };
    const buf = new TiledBuffer(RGBA16, { memory });
    buf.writableTile(0, 0);
    buf.captureTile(0, 0);
    buf.writableTile(0, 0); // copy-on-write allocates again
    expect(sizes).toEqual([TILE_SIZE * TILE_SIZE * 4 * 2, TILE_SIZE * TILE_SIZE * 4 * 2]);
  });
});
