import { describe, expect, it } from 'vitest';
import { compositeTiles } from '../../../../src/core/composite/composite-tiles';
import { planFromDocument } from '../../../../src/core/composite/flatten';
import { ImageDocument } from '../../../../src/core/document/document';
import { TILE_SIZE } from '../../../../src/core/document/tile';

function docWith(depth: 8 | 16 = 8) {
  const doc = new ImageDocument({ width: 600, height: 300, depth });
  const layer = doc.createPixelLayer();
  doc.insertLayer(layer);
  const max = depth === 8 ? 255 : 65535;
  const data = depth === 8 ? new Uint8Array(10 * 10 * 4) : new Uint16Array(10 * 10 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([max, 0, 0, Math.round(max / 2)], i);
  layer.buffer.writeRegion({ x: 300, y: 20, w: 10, h: 10 }, data); // in tile (1, 0)
  return { doc, layer };
}

const pixel = (data: ArrayLike<number>, x: number, y: number, spp: number) =>
  Array.from({ length: spp }, (_, c) => data[(y * TILE_SIZE + x) * spp + c]!);

describe('compositeTiles', () => {
  it('returns only tiles with visible pixels, on the document tile grid', () => {
    const { doc } = docWith();
    const tiles = compositeTiles(planFromDocument(doc), doc.canvasRect, doc.layerFormat(true), null);
    expect(tiles.map((t) => [t.tx, t.ty])).toEqual([[1, 0]]);
    expect(pixel(tiles[0]!.data, 300 - TILE_SIZE, 20, 4)).toEqual([255, 0, 0, 128]);
    expect(pixel(tiles[0]!.data, 0, 0, 4)).toEqual([0, 0, 0, 0]);
  });

  it('composites over a matte without alpha, leaving out tiles that are only the matte', () => {
    const { doc } = docWith();
    const tiles = compositeTiles(planFromDocument(doc), doc.canvasRect, doc.layerFormat(false), [255, 255, 255]);
    expect(tiles.map((t) => [t.tx, t.ty])).toEqual([[1, 0]]);
    expect(pixel(tiles[0]!.data, 300 - TILE_SIZE, 20, 3)).toEqual([255, 127, 127]);
    expect(pixel(tiles[0]!.data, 0, 0, 3)).toEqual([255, 255, 255]);
  });

  it('clips to the rectangle and works in 16-bit', () => {
    const { doc } = docWith(16);
    const tiles = compositeTiles(planFromDocument(doc), { x: 305, y: 0, w: 100, h: 300 }, doc.layerFormat(true), null);
    expect(tiles).toHaveLength(1);
    expect(pixel(tiles[0]!.data, 304 - TILE_SIZE, 20, 4)).toEqual([0, 0, 0, 0]); // left of the rectangle
    expect(pixel(tiles[0]!.data, 305 - TILE_SIZE, 20, 4)).toEqual([65535, 0, 0, 32768]);
  });
});
