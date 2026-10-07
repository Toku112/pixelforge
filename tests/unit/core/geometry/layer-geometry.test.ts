import { describe, expect, it } from 'vitest';
import {
  mapLayer,
  resampleLayer,
  type LayerSource,
  type LayerTile,
} from '../../../../src/core/geometry/layer-geometry';
import { TILE_SIZE } from '../../../../src/core/document/tile';

const rgba = { depth: 8 as const, colorChannels: 3, hasAlpha: true };
const rgb = { depth: 8 as const, colorChannels: 3, hasAlpha: false };

/** A source layer from a function of document coordinates over a small area. */
function source(w: number, h: number, fn: (x: number, y: number) => number[], format = rgba): LayerSource {
  const spp = format.hasAlpha ? 4 : 3;
  const data = new Uint8Array(TILE_SIZE * TILE_SIZE * spp);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), (y * TILE_SIZE + x) * spp);
  return {
    format,
    defaultPixel: format.hasAlpha ? [0, 0, 0, 0] : [255, 255, 255],
    offsetX: 0,
    offsetY: 0,
    tiles: [{ tx: 0, ty: 0, data }],
    domain: format.hasAlpha ? null : { x: 0, y: 0, w, h },
  };
}

function pixelOf(tiles: LayerTile[], x: number, y: number, spp = 4): number[] {
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  const t = tiles.find((t) => t.tx === tx && t.ty === ty);
  if (!t) return [];
  const i = ((y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE)) * spp;
  return [...t.data.slice(i, i + spp)];
}

describe('exact layer geometry', () => {
  // A 4 × 2 canvas whose pixels encode their position: [x, y, 0, 255].
  const marked = source(4, 2, (x, y) => [x, y, 0, 255]);

  it('rotates 90° clockwise and counter-clockwise, and 180°', () => {
    const cw = mapLayer(marked, { kind: 'rotate', turns: 1, width: 4, height: 2 }, { x: 0, y: 0, w: 2, h: 4 }, null);
    // Old (x, y) lands at (H − 1 − y, x): old (0, 0) → (1, 0); old (3, 1) → (0, 3).
    expect(pixelOf(cw, 1, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelOf(cw, 0, 3)).toEqual([3, 1, 0, 255]);
    const ccw = mapLayer(marked, { kind: 'rotate', turns: 3, width: 4, height: 2 }, { x: 0, y: 0, w: 2, h: 4 }, null);
    expect(pixelOf(ccw, 0, 3)).toEqual([0, 0, 0, 255]);
    const half = mapLayer(marked, { kind: 'rotate', turns: 2, width: 4, height: 2 }, { x: 0, y: 0, w: 4, h: 2 }, null);
    expect(pixelOf(half, 0, 0)).toEqual([3, 1, 0, 255]);
  });

  it('flips and shifts', () => {
    const flipped = mapLayer(marked, { kind: 'flip', axis: 'horizontal', width: 4, height: 2 }, null, null);
    expect(pixelOf(flipped, 0, 1)).toEqual([3, 1, 0, 255]);
    const shifted = mapLayer(marked, { kind: 'shift', dx: 300, dy: 0 }, null, null);
    expect(pixelOf(shifted, 302, 1)).toEqual([2, 1, 0, 255]);
  });

  it('extends a Background with the fill colour (canvas size)', () => {
    const bg = source(4, 2, () => [10, 20, 30], rgb);
    const out = mapLayer(bg, { kind: 'shift', dx: 2, dy: 0 }, { x: 0, y: 0, w: 8, h: 2 }, [0, 0, 255]);
    expect(pixelOf(out, 0, 0, 3)).toEqual([0, 0, 255]);
    expect(pixelOf(out, 3, 1, 3)).toEqual([10, 20, 30]);
    expect(pixelOf(out, 7, 1, 3)).toEqual([0, 0, 255]);
  });
});

describe('resampling', () => {
  it('nearest neighbour doubles each pixel', () => {
    const out = resampleLayer(
      source(2, 1, (x) => [x * 200, 0, 0, 255]),
      2,
      2,
      'nearest',
      null,
      null,
    );
    expect([0, 1, 2, 3].map((x) => pixelOf(out, x, 0)[0])).toEqual([0, 0, 200, 200]);
    expect(pixelOf(out, 3, 1)).toEqual([200, 0, 0, 255]);
  });

  it('averages when reducing, and keeps the colour of transparent edges (premultiplied)', () => {
    const checker = resampleLayer(
      source(8, 8, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255])),
      0.5,
      0.5,
      'bilinear',
      null,
      null,
    );
    const v = pixelOf(checker, 1, 1)[0]!; // an inner pixel: all its sources are inside
    expect(Math.abs(v - 128)).toBeLessThanOrEqual(2);
    // Opaque red next to transparency: half covered, still pure red.
    const edge = resampleLayer(
      source(2, 2, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0])),
      0.5,
      0.5,
      'bicubic',
      null,
      null,
    );
    const p = pixelOf(edge, 0, 0);
    expect(p.slice(0, 3)).toEqual([255, 0, 0]);
    expect(p[3]).toBeGreaterThan(90);
    expect(p[3]).toBeLessThan(165);
  });

  it('repeats the edges of the Background instead of blending in the fill colour', () => {
    const bg = source(4, 4, () => [10, 20, 30], rgb);
    const out = resampleLayer(bg, 2, 2, 'bicubic', { x: 0, y: 0, w: 8, h: 8 }, [255, 255, 255]);
    expect(pixelOf(out, 0, 0, 3)).toEqual([10, 20, 30]);
    expect(pixelOf(out, 7, 7, 3)).toEqual([10, 20, 30]);
  });

  it('keeps flat areas flat with every method', () => {
    for (const method of ['bilinear', 'bicubic', 'bicubic-smoother', 'bicubic-sharper', 'automatic'] as const) {
      const out = resampleLayer(
        source(8, 8, () => [100, 150, 200, 255]),
        1.5,
        1.5,
        method,
        null,
        null,
      );
      expect(pixelOf(out, 6, 6)).toEqual([100, 150, 200, 255]);
    }
  });
});
