import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../../../../src/core/commands/command';
import type { ImageDocument } from '../../../../src/core/document/document';
import { NO_LOCKS, type PixelLayer } from '../../../../src/core/document/layers';
import { History } from '../../../../src/core/history/history';
import { createContext, withBackground } from '../helpers';

function setup() {
  const env = withBackground(createContext({ width: 300, height: 200 }));
  const history = new History(env.doc);
  const run = (name: string, params: CommandDescriptor['params'] = {}) =>
    history.execute(env.registry.create(env.ctx, { name, params }));
  const available = (name: string) => env.registry.isAvailable(name, env.ctx);
  return { ...env, history, run, available };
}

function layerWith(
  doc: ImageDocument,
  rect: { x: number; y: number; w: number; h: number },
  rgba: number[],
): PixelLayer {
  const layer = doc.createPixelLayer();
  doc.insertLayer(layer);
  const data = new Uint8Array(rect.w * rect.h * 4);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i % 4]!;
  layer.buffer.writeRegion(rect, data);
  doc.setActiveLayer(layer.id);
  return layer;
}

describe('moving layers', () => {
  it('moves the selected layers (and groups with their contents) by whole pixels; undo restores', async () => {
    const { doc, history, run } = setup();
    const a = layerWith(doc, { x: 0, y: 0, w: 10, h: 10 }, [255, 0, 0, 255]);
    const g = doc.createGroup('G');
    doc.insertLayer(g);
    const inner = doc.createPixelLayer('Inner');
    doc.insertLayer(inner, g.id);
    doc.selectLayers([a.id, g.id]);
    await run('translateLayers', { dx: 15, dy: -4 });
    expect([a.offsetX, a.offsetY, inner.offsetX, inner.offsetY]).toEqual([15, -4, 15, -4]);
    expect(history.entries.at(-1)!.label).toBe('Move');
    await run('translateLayers', { dx: 1, dy: 0, nudge: true });
    expect(history.entries.at(-1)!.label).toBe('Nudge');
    await history.undo();
    await history.undo();
    expect([a.offsetX, a.offsetY]).toEqual([0, 0]);
  });

  it('refuses the Background and position-locked layers', () => {
    const { doc, run, available } = setup();
    expect(available('translateLayers')).toBe(false); // the Background is selected
    const a = layerWith(doc, { x: 0, y: 0, w: 1, h: 1 }, [1, 1, 1, 255]);
    expect(available('translateLayers')).toBe(true);
    doc.updateLayer(a.id, { locks: { ...NO_LOCKS, position: true } });
    expect(available('translateLayers')).toBe(false);
    expect(() => run('translateLayers', { dx: 0.5, dy: 0 })).toThrow('whole pixels');
  });
});

describe('moving selected pixels', () => {
  it('lifts the selection, leaves transparency, and moves the selection with the pixels', async () => {
    const { doc, history, run, available } = setup();
    const layer = layerWith(doc, { x: 0, y: 0, w: 100, h: 100 }, [255, 0, 0, 255]);
    expect(available('moveSelectedPixels')).toBe(false);
    await run('selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 10, y: 10, w: 20, h: 20 } });
    await run('moveSelectedPixels', { dx: 150, dy: 5 });
    expect(history.entries.at(-1)!.label).toBe('Move');
    expect(layer.buffer.getPixel(15, 15)).toEqual([255, 0, 0, 0]); // left behind: transparent
    expect(layer.buffer.getPixel(165, 20)).toEqual([255, 0, 0, 255]); // arrived
    expect(layer.buffer.getPixel(50, 50)).toEqual([255, 0, 0, 255]); // untouched
    expect(doc.selection!.value(165, 20, doc.canvasRect)).toBe(255);
    expect(doc.selection!.value(15, 15, doc.canvasRect)).toBe(0);
    await history.undo();
    expect(layer.buffer.getPixel(15, 15)).toEqual([255, 0, 0, 255]);
    expect(layer.buffer.getPixel(165, 20)).toEqual([0, 0, 0, 0]);
    expect(doc.selection!.value(15, 15, doc.canvasRect)).toBe(255);
  });

  it('on the Background leaves the background colour and lays the pixels over what is there', async () => {
    const { doc, run } = setup();
    const bg = doc.background!;
    bg.buffer.writeRegion({ x: 0, y: 0, w: 10, h: 10 }, new Uint8Array(10 * 10 * 3).fill(0)); // black square
    doc.setActiveLayer(bg.id);
    await run('selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 0, y: 0, w: 10, h: 10 } });
    await run('moveSelectedPixels', { dx: 20, dy: 0, color: [0, 0, 255] });
    expect(bg.buffer.getPixel(5, 5)).toEqual([0, 0, 255]);
    expect(bg.buffer.getPixel(25, 5)).toEqual([0, 0, 0]);
    expect(bg.buffer.getPixel(35, 5)).toEqual([255, 255, 255]);
  });
});
