import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../../../../src/core/commands/command';
import { transformTargets } from '../../../../src/core/commands/builtin/transform';
import type { ImageDocument } from '../../../../src/core/document/document';
import type { PixelLayer } from '../../../../src/core/document/layers';
import { about, rotation, scaling, translation, type Mat3 } from '../../../../src/core/geometry/transform';
import { History } from '../../../../src/core/history/history';
import { createContext, withBackground } from '../helpers';

function setup() {
  const env = withBackground(createContext({ width: 300, height: 200 }));
  const history = new History(env.doc);
  const run = (name: string, params: CommandDescriptor['params'] = {}) =>
    history.execute(env.registry.create(env.ctx, { name, params }));
  const transform = (m: Mat3, more: CommandDescriptor['params'] = {}) =>
    run('freeTransform', { matrix: [...m], interpolation: 'nearest', ...more });
  return { ...env, history, run, transform };
}

/** A new top layer with a red block over (x, y, w, h). */
function blockLayer(doc: ImageDocument, x: number, y: number, w: number, h: number): PixelLayer {
  const layer = doc.createPixelLayer();
  doc.insertLayer(layer);
  doc.setActiveLayer(layer.id);
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([255, 0, 0, 255], i * 4);
  layer.buffer.writeRegion({ x, y, w, h }, px);
  return layer;
}

const pixel = (doc: ImageDocument, layer: PixelLayer, x: number, y: number) => {
  const l = doc.requirePixelLayer(layer.id);
  return l.buffer.getPixel(x - l.offsetX, y - l.offsetY);
};

describe('Edit > Free Transform', () => {
  it('scales and moves a layer as one undoable step', async () => {
    const { doc, history, transform } = setup();
    const layer = blockLayer(doc, 10, 10, 20, 10);
    await transform(translation(100, 50));
    expect(history.entries.at(-1)!.label).toBe('Free Transform');
    expect(pixel(doc, layer, 110, 60)).toEqual([255, 0, 0, 255]);
    expect(pixel(doc, layer, 10, 10)[3]).toBe(0);
    await history.undo();
    expect(pixel(doc, layer, 10, 10)).toEqual([255, 0, 0, 255]);
    expect(pixel(doc, layer, 110, 60)[3]).toBe(0);
    await history.redo();
    expect(pixel(doc, layer, 110, 60)).toEqual([255, 0, 0, 255]);
    await transform(about({ x: 10, y: 10 }, scaling(2, 2)), { interpolation: 'bilinear' });
    expect(pixel(doc, layer, 10 + 200 + 30, 10 + 100 + 15)).toEqual([255, 0, 0, 255]);
  });

  it('rotates a layer that sits at an offset, keeping pixels beyond the canvas', async () => {
    const { doc, transform } = setup();
    const layer = blockLayer(doc, 0, 0, 10, 4);
    doc.updateLayer(layer.id, { offsetX: 290, offsetY: 100 });
    await transform(about({ x: 290, y: 100 }, rotation(Math.PI / 2)));
    // (290 + x, 100 + y) → (290 − y, 100 + x): the block now runs downwards, left of x = 290.
    expect(pixel(doc, layer, 287, 108)).toEqual([255, 0, 0, 255]);
    expect(pixel(doc, layer, 295, 101)[3]).toBe(0);
  });

  it('with a selection, transforms the selected pixels and the selection', async () => {
    const { doc, history, run, transform } = setup();
    const layer = blockLayer(doc, 10, 10, 40, 10);
    await run('selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 10, y: 10, w: 10, h: 10 } });
    await transform(translation(0, 50));
    expect(pixel(doc, layer, 12, 12)[3]).toBe(0); // lifted
    expect(pixel(doc, layer, 30, 12)).toEqual([255, 0, 0, 255]); // not selected
    expect(pixel(doc, layer, 12, 62)).toEqual([255, 0, 0, 255]); // arrived
    expect(doc.selection!.value(12, 62, doc.canvasRect)).toBe(255);
    expect(doc.selection!.value(12, 12, doc.canvasRect)).toBe(0);
    await history.undo();
    expect(doc.selection!.value(12, 12, doc.canvasRect)).toBe(255);
    expect(pixel(doc, layer, 12, 12)).toEqual([255, 0, 0, 255]);
  });

  it('on the Background only with a selection; the old place gets the background colour', async () => {
    const { doc, run, transform } = setup();
    const bg = doc.background!;
    expect(transformTargets(doc)).toMatchObject({ kind: 'refused' });
    await expect(transform(translation(5, 0))).rejects.toThrow('Background');
    bg.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([1, 2, 3]));
    await run('selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 0, y: 0, w: 10, h: 10 } });
    await transform(translation(20, 0), { color: [0, 0, 255] });
    expect(bg.buffer.getPixel(20, 0)).toEqual([1, 2, 3]);
    expect(bg.buffer.getPixel(0, 0)).toEqual([0, 0, 255]);
  });

  it('live previews compute only the visible area, one sample per block', async () => {
    const { doc, ctx, registry } = setup();
    const layer = blockLayer(doc, 0, 0, 100, 100);
    const preview = registry.create(ctx, {
      name: 'freeTransform',
      params: { matrix: [...translation(1, 0)], draft: { x: 0, y: 0, w: 40, h: 40, step: 4 } },
    });
    await preview.execute();
    expect(pixel(doc, layer, 30, 30)).toEqual([255, 0, 0, 255]);
    expect(pixel(doc, layer, 60, 60)[3]).toBe(0); // outside the visible area: not computed
    preview.undo();
    expect(pixel(doc, layer, 60, 60)).toEqual([255, 0, 0, 255]);
  });

  it('refuses locked layers and invalid parameters', () => {
    const { doc, transform } = setup();
    const layer = blockLayer(doc, 0, 0, 4, 4);
    doc.updateLayer(layer.id, { locks: { ...layer.locks, position: true } });
    expect(transformTargets(doc)).toEqual({ kind: 'refused', reason: 'A selected layer is locked.' });
    expect(() => transform([0, 0, 0, 0, 0, 0, 0, 0, 1])).toThrow('collapses');
    expect(() => transform(translation(1, 1), { interpolation: 'magic' })).toThrow('interpolation');
  });
});

describe('Free Transform at other bit depths', () => {
  it.each([16, 32] as const)('moves and scales %i-bit layers', async (depth) => {
    const env = withBackground(createContext({ width: 64, height: 64, depth }));
    const history = new History(env.doc);
    const doc = env.doc;
    const layer = doc.createPixelLayer();
    doc.insertLayer(layer);
    doc.setActiveLayer(layer.id);
    const max = depth === 16 ? 65535 : 1;
    const px = depth === 16 ? new Uint16Array(4 * 4 * 4) : new Float32Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) px.set([max, 0, max / 2, max], i * 4);
    layer.buffer.writeRegion({ x: 0, y: 0, w: 4, h: 4 }, px);
    await history.execute(
      env.registry.create(env.ctx, {
        name: 'freeTransform',
        params: { matrix: [...about({ x: 0, y: 0 }, scaling(2, 2))].map((v, i) => (i === 2 ? v + 10 : v)) },
      }),
    );
    const got = pixel(doc, layer, 13, 3);
    expect(got[0]).toBeCloseTo(max, depth === 32 ? 3 : -1);
    expect(got[3]).toBeCloseTo(max, depth === 32 ? 3 : -1);
    expect(pixel(doc, layer, 2, 2)[3]).toBe(0);
  });
});
