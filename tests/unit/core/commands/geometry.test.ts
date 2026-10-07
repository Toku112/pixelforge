import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../../../../src/core/commands/command';
import type { ImageDocument } from '../../../../src/core/document/document';
import type { PixelLayer } from '../../../../src/core/document/layers';
import { History } from '../../../../src/core/history/history';
import { createContext, withBackground } from '../helpers';

function setup() {
  const env = withBackground(createContext({ width: 300, height: 200 }));
  const history = new History(env.doc);
  const run = (name: string, params: CommandDescriptor['params'] = {}) =>
    history.execute(env.registry.create(env.ctx, { name, params }));
  return { ...env, history, run };
}

/** A new top layer with a few marked pixels. */
function markedLayer(doc: ImageDocument, marks: [number, number, number[]][]): PixelLayer {
  const layer = doc.createPixelLayer();
  doc.insertLayer(layer);
  doc.setActiveLayer(layer.id);
  for (const [x, y, px] of marks) layer.buffer.writeRegion({ x, y, w: 1, h: 1 }, new Uint8Array(px));
  return layer;
}

const layerNamed = (doc: ImageDocument, name: string) =>
  [...doc.root.children].find((l) => l.name === name) as PixelLayer;

describe('Image > Canvas Size', () => {
  it('adds canvas around the centre: the Background gets the colour, layers just move', async () => {
    const { doc, history, run } = setup();
    markedLayer(doc, [[0, 0, [255, 0, 0, 255]]]);
    await run('canvasSize', { width: 400, height: 300, color: [0, 0, 255] });
    expect(history.entries.at(-1)!.label).toBe('Canvas Size');
    expect([doc.width, doc.height]).toEqual([400, 300]);
    const bg = doc.background!;
    expect(bg.buffer.getPixel(0, 0)).toEqual([0, 0, 255]);
    expect(bg.buffer.getPixel(50, 50)).toEqual([255, 255, 255]);
    expect(bg.buffer.getPixel(349, 249)).toEqual([255, 255, 255]);
    expect(bg.buffer.getPixel(350, 250)).toEqual([0, 0, 255]);
    const layer = layerNamed(doc, 'Layer 1');
    expect([layer.offsetX, layer.offsetY]).toEqual([50, 50]);
    expect(layer.buffer.getPixel(0, 0)).toEqual([255, 0, 0, 255]);
    expect(doc.activeLayer?.name).toBe('Layer 1');

    await history.undo();
    expect([doc.width, doc.height]).toEqual([300, 200]);
    expect(doc.background!.buffer.getPixel(0, 0)).toEqual([255, 255, 255]);
    expect(layerNamed(doc, 'Layer 1').offsetX).toBe(0);
    await history.redo();
    expect(doc.background!.buffer.getPixel(0, 0)).toEqual([0, 0, 255]);
  });

  it('shrinking from the top-left corner keeps layer pixels beyond the canvas', async () => {
    const { doc, run } = setup();
    markedLayer(doc, [[250, 150, [0, 255, 0, 255]]]);
    await run('selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 190, y: 90, w: 40, h: 40 } });
    await run('canvasSize', { width: 100, height: 100, anchor: [1, 1] });
    expect([doc.width, doc.height]).toEqual([100, 100]);
    const layer = layerNamed(doc, 'Layer 1');
    expect([layer.offsetX, layer.offsetY]).toEqual([-200, -100]);
    expect(layer.buffer.getPixel(250, 150)).toEqual([0, 255, 0, 255]);
    // The selection moved with the image.
    expect([5, 35].map((v) => doc.selection!.value(v, v, doc.canvasRect))).toEqual([255, 0]);
  });
});

describe('Crop', () => {
  it('deletes cropped pixels by default and moves the selection', async () => {
    const { doc, history, run } = setup();
    const layer = markedLayer(doc, [
      [10, 10, [255, 0, 0, 255]],
      [200, 150, [0, 255, 0, 255]],
    ]);
    await run('selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 10, y: 10, w: 20, h: 20 } });
    await run('crop', { x: 5, y: 5, w: 100, h: 100 });
    expect(history.entries.at(-1)!.label).toBe('Crop');
    expect([doc.width, doc.height]).toEqual([100, 100]);
    const after = layerNamed(doc, layer.name);
    expect([after.offsetX, after.offsetY]).toEqual([0, 0]);
    expect(after.buffer.getPixel(5, 5)).toEqual([255, 0, 0, 255]);
    expect(after.buffer.getPixel(195, 145)).toEqual([0, 0, 0, 0]);
    expect([...after.buffer.tiles()].length).toBe(1);
    expect([4, 5, 24, 25].map((v) => doc.selection!.value(v, v, doc.canvasRect))).toEqual([0, 255, 255, 0]);
  });

  it('without a rectangle, crops to the bounds of the selection (Image > Crop)', async () => {
    const { doc, run } = setup();
    await run('selectShape', { tool: 'elliptical-marquee', shape: { kind: 'ellipse', x: 40, y: 30, w: 50, h: 20 } });
    await run('crop');
    expect([doc.width, doc.height]).toEqual([50, 20]);
    await run('deselect');
    await expect(run('crop')).rejects.toThrow('needs a selection');
  });

  it('keeping cropped pixels turns the Background into a normal layer', async () => {
    const { doc, history, run } = setup();
    await run('crop', { x: 50, y: 20, w: 100, h: 100, deleteCropped: false });
    expect(doc.background).toBeUndefined();
    const layer = layerNamed(doc, 'Layer 0');
    expect(layer.buffer.format.hasAlpha).toBe(true);
    expect([layer.offsetX, layer.offsetY]).toEqual([-50, -20]);
    expect(layer.buffer.getPixel(299, 199)).toEqual([255, 255, 255, 255]);
    await history.undo();
    expect(doc.background?.name).toBe('Background');
  });
});

describe('Image > Image Rotation', () => {
  it('turns every layer a quarter clockwise and deselects', async () => {
    const { doc, history, run } = setup();
    doc.background!.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([1, 2, 3]));
    const layer = markedLayer(doc, [[299, 0, [255, 0, 0, 255]]]);
    await run('selectAll');
    await run('rotateCanvas', { turns: 1 });
    expect(history.entries.at(-1)!.label).toBe('Rotate Canvas');
    expect([doc.width, doc.height]).toEqual([200, 300]);
    // Old (x, y) → (H − 1 − y, x).
    expect(doc.background!.buffer.getPixel(199, 0)).toEqual([1, 2, 3]);
    expect(layerNamed(doc, layer.name).buffer.getPixel(199, 299)).toEqual([255, 0, 0, 255]);
    expect(doc.selection).toBeNull();
    expect(doc.reselectable).not.toBeNull();
    await history.undo();
    expect(doc.selection).not.toBeNull();
  });

  it('rotates 180° and flips', async () => {
    const { doc, history, run } = setup();
    doc.background!.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([1, 2, 3]));
    await run('rotateCanvas', { turns: 2 });
    expect(doc.background!.buffer.getPixel(299, 199)).toEqual([1, 2, 3]);
    await run('rotateCanvas', { flip: 'horizontal' });
    expect(history.entries.at(-1)!.label).toBe('Flip Canvas Horizontal');
    expect(doc.background!.buffer.getPixel(0, 199)).toEqual([1, 2, 3]);
    await run('rotateCanvas', { flip: 'vertical' });
    expect(doc.background!.buffer.getPixel(0, 0)).toEqual([1, 2, 3]);
    expect(() => run('rotateCanvas', { turns: 4 })).toThrow('turns');
    expect(() => run('rotateCanvas', {})).toThrow('either');
  });
});

describe('Image > Image Size', () => {
  it('resamples every layer', async () => {
    const { doc, history, run } = setup();
    // An 8 × 8 red block at (100, 100) becomes 4 × 4 at (50, 50), soft at its edges.
    const marks: [number, number, number[]][] = [];
    for (let y = 100; y < 108; y++) for (let x = 100; x < 108; x++) marks.push([x, y, [255, 0, 0, 255]]);
    markedLayer(doc, marks);
    await run('imageSize', { width: 150, height: 100, method: 'bilinear' });
    expect(history.entries.at(-1)!.label).toBe('Image Size');
    expect([doc.width, doc.height]).toEqual([150, 100]);
    const layer = layerNamed(doc, 'Layer 1');
    expect(layer.buffer.getPixel(52, 52)).toEqual([255, 0, 0, 255]);
    expect(layer.buffer.getPixel(50, 50)[3]).toBeGreaterThan(128);
    expect(layer.buffer.getPixel(48, 48)[3]).toBe(0);
    expect(doc.background!.buffer.getPixel(149, 99)).toEqual([255, 255, 255]);
  });

  it('changing only the resolution keeps the pixels and the selection', async () => {
    const { doc, run } = setup();
    await run('selectAll');
    const tiles = [...doc.background!.buffer.tiles()].map(([, , t]) => t);
    await run('imageSize', { width: 300, height: 200, resolution: 300 });
    expect(doc.resolution).toBe(300);
    expect(doc.selection).not.toBeNull();
    expect([...doc.background!.buffer.tiles()].map(([, , t]) => t)).toEqual(tiles);
    expect(() => run('imageSize', { width: 0, height: 10 })).toThrow('width');
    expect(() => run('imageSize', { width: 10, height: 10, method: 'magic' })).toThrow('method');
  });
});

describe('other bit depths', () => {
  it.each([16, 32] as const)('rotates and resizes %i-bit documents', async (depth) => {
    const env = withBackground(createContext({ width: 30, height: 20, depth }));
    const history = new History(env.doc);
    const run = (name: string, params: CommandDescriptor['params'] = {}) =>
      history.execute(env.registry.create(env.ctx, { name, params }));
    const white = env.doc.whitePixel();
    await run('rotateCanvas', { turns: 3 });
    await run('imageSize', { width: 40, height: 60, method: 'bicubic' });
    expect([env.doc.width, env.doc.height]).toEqual([40, 60]);
    expect(env.doc.background!.buffer.getPixel(20, 30)).toEqual(white);
    await run('canvasSize', { width: 50, height: 60, anchor: [0, 0.5], color: white.map(() => 0) });
    expect(env.doc.background!.buffer.getPixel(45, 30)).toEqual([0, 0, 0]);
  });
});
