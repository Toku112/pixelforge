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

const addLayer = (doc: ImageDocument) => {
  const layer = doc.createPixelLayer();
  doc.insertLayer(layer);
  doc.setActiveLayer(layer.id);
  return layer;
};

describe('Edit > Fill', () => {
  it('fills the whole canvas of the Background as one undoable step', async () => {
    const { doc, history, run } = setup();
    await run('fill', { color: [255, 0, 0] });
    expect(history.entries.at(-1)!.label).toBe('Fill');
    expect(doc.background!.buffer.getPixel(0, 0)).toEqual([255, 0, 0]);
    expect(doc.background!.buffer.getPixel(299, 199)).toEqual([255, 0, 0]);
    await history.undo();
    expect(doc.background!.buffer.getPixel(10, 10)).toEqual([255, 255, 255]);
  });

  it('fills only the selection, blended with a mode and opacity', async () => {
    const { doc, run } = setup();
    await run('selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 0, y: 0, w: 100, h: 100 } });
    await run('fill', { color: [0, 128, 255], mode: 'multiply', opacity: 0.5 });
    // White × colour = colour; half way there at 50 %.
    expect(doc.background!.buffer.getPixel(50, 50)).toEqual([128, 192, 255]);
    expect(doc.background!.buffer.getPixel(150, 150)).toEqual([255, 255, 255]);
  });

  it('fills a transparent layer over the whole canvas (not beyond it)', async () => {
    const { doc, run } = setup();
    const layer = addLayer(doc);
    await run('fill', { color: [10, 20, 30] });
    expect(layer.buffer.getPixel(299, 199)).toEqual([10, 20, 30, 255]);
    expect(layer.buffer.getPixel(300, 10)).toEqual([0, 0, 0, 0]);
  });

  it('Preserve Transparency only recolours existing pixels; the mode applies against them', async () => {
    const { doc, run } = setup();
    const layer: PixelLayer = addLayer(doc);
    layer.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([200, 100, 50, 128]));
    await run('fill', { color: [0, 0, 255], preserveTransparency: true });
    expect(layer.buffer.getPixel(0, 0)).toEqual([0, 0, 255, 128]);
    expect(layer.buffer.getPixel(5, 5)).toEqual([0, 0, 0, 0]);
    expect(() => run('fill', { color: [1, 2, 3], mode: 'nope' })).toThrow('blend mode');
  });
});
