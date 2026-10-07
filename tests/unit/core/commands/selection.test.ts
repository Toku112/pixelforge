import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../../../../src/core/commands/command';
import type { ImageDocument } from '../../../../src/core/document/document';
import { NO_LOCKS, type PixelLayer } from '../../../../src/core/document/layers';
import { History } from '../../../../src/core/history/history';
import { captureDocumentState, restoreDocumentState } from '../../../../src/core/history/snapshot';
import { createContext, withBackground } from '../helpers';

function setup() {
  const env = withBackground(createContext({ width: 300, height: 200 }));
  const history = new History(env.doc);
  const run = (name: string, params: CommandDescriptor['params'] = {}) =>
    history.execute(env.registry.create(env.ctx, { name, params }));
  const available = (name: string) => env.registry.isAvailable(name, env.ctx);
  return { ...env, history, run, available };
}

const marquee = (x: number, y: number, w: number, h: number, mode = 'new', feather = 0) => ({
  tool: 'rectangular-marquee',
  shape: { kind: 'rect', x, y, w, h },
  mode,
  feather,
  antiAlias: true,
});

const selected = (doc: ImageDocument, x: number, y: number) => doc.selection?.value(x, y, doc.canvasRect) ?? 0;

function fillLayer(doc: ImageDocument, rgba: number[]): PixelLayer {
  const layer = doc.createPixelLayer();
  doc.insertLayer(layer);
  const data = new Uint8Array(300 * 200 * 4);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i % 4]!;
  layer.buffer.writeRegion(doc.canvasRect, data);
  doc.setActiveLayer(layer.id);
  return layer;
}

describe('selection commands', () => {
  it('draws marquee selections as named history steps, with undo and redo', async () => {
    const { doc, history, run } = setup();
    await run('selectShape', marquee(10, 10, 50, 40));
    expect([selected(doc, 10, 10), selected(doc, 59, 49), selected(doc, 60, 10)]).toEqual([255, 255, 0]);
    await run('selectShape', marquee(100, 100, 20, 20, 'add'));
    expect([selected(doc, 30, 30), selected(doc, 110, 110)]).toEqual([255, 255]);
    expect(history.entries.map((e) => e.label)).toEqual(['Open', 'Rectangular Marquee', 'Rectangular Marquee']);
    await history.undo();
    expect(selected(doc, 110, 110)).toBe(0);
    await history.undo();
    expect(doc.selection).toBeNull();
    await history.redo();
    expect(selected(doc, 30, 30)).toBe(255);
  });

  it('Select All, Deselect, Reselect and Inverse', async () => {
    const { doc, run, available } = setup();
    expect(available('deselect')).toBe(false);
    expect(available('inverseSelection')).toBe(false);
    await run('selectShape', marquee(0, 0, 100, 200));
    await run('inverseSelection');
    expect([selected(doc, 50, 50), selected(doc, 150, 50)]).toEqual([0, 255]);
    await run('deselect');
    expect(doc.selection).toBeNull();
    expect(available('reselect')).toBe(true);
    await run('reselect');
    expect(selected(doc, 150, 50)).toBe(255);
    await run('selectAll');
    expect([selected(doc, 0, 0), selected(doc, 299, 199), selected(doc, 300, 0)]).toEqual([255, 255, 0]);
    await run('inverseSelection'); // inverse of everything: nothing
    expect(doc.selection).toBeNull();
  });

  it('a shape that selects nothing deselects; Reselect brings back the previous selection', async () => {
    const { doc, run } = setup();
    await run('selectShape', marquee(10, 10, 20, 20));
    await run('selectShape', marquee(400, 400, 20, 20)); // outside the canvas
    expect(doc.selection).toBeNull();
    await run('reselect');
    expect(selected(doc, 15, 15)).toBe(255);
  });

  it('moves the selection outline by whole pixels', async () => {
    const { doc, history, run } = setup();
    await run('selectShape', marquee(10, 10, 20, 20));
    await run('moveSelection', { dx: 100, dy: 5 });
    expect([selected(doc, 15, 15), selected(doc, 115, 20)]).toEqual([0, 255]);
    expect(history.entries.at(-1)!.label).toBe('Move Selection');
    expect(() => run('moveSelection', { dx: 0.5, dy: 0 })).toThrow('whole pixels');
  });

  it('validates shapes, modes and feather', () => {
    const { run } = setup();
    expect(() => run('selectShape', { ...marquee(0, 0, 1, 1), tool: 'magic' })).toThrow('unknown tool');
    expect(() => run('selectShape', { ...marquee(0, 0, 1, 1), mode: 'xor' })).toThrow('mode');
    expect(() => run('selectShape', marquee(0, 0, 1, 1, 'new', -1))).toThrow('feather');
    expect(() => run('selectShape', { tool: 'lasso', shape: { kind: 'polygon', points: [0, 0, 1, 1] } })).toThrow(
      'three',
    );
  });

  it('history snapshots keep the selection', async () => {
    const { doc, run } = setup();
    await run('selectShape', marquee(10, 10, 20, 20));
    const state = captureDocumentState(doc);
    await run('deselect');
    restoreDocumentState(doc, state);
    expect(selected(doc, 15, 15)).toBe(255);
  });
});

describe('editing through a selection', () => {
  it('Invert changes only the selected pixels, partly at feathered edges', async () => {
    const { doc, run } = setup();
    const layer = fillLayer(doc, [200, 100, 0, 255]);
    await run('selectShape', marquee(0, 0, 100, 200, 'new', 4));
    await run('invert');
    expect(layer.buffer.getPixel(20, 20)).toEqual([55, 155, 255, 255]);
    expect(layer.buffer.getPixel(250, 20)).toEqual([200, 100, 0, 255]);
    const edge = layer.buffer.getPixel(100, 20)[0]!;
    expect(edge).toBeGreaterThan(55);
    expect(edge).toBeLessThan(200);
  });

  it('Clear makes the selection transparent on a layer and fills the Background with the background colour', async () => {
    const { doc, history, run, available } = setup();
    const layer = fillLayer(doc, [10, 20, 30, 255]);
    expect(available('clear')).toBe(false); // needs a selection
    await run('selectShape', marquee(50, 50, 10, 10));
    await run('clear');
    expect(history.entries.at(-1)!.label).toBe('Clear');
    expect(layer.buffer.getPixel(55, 55)).toEqual([10, 20, 30, 0]);
    expect(layer.buffer.getPixel(45, 55)).toEqual([10, 20, 30, 255]);
    await history.undo();
    expect(layer.buffer.getPixel(55, 55)).toEqual([10, 20, 30, 255]);

    // Locked transparency: filled instead, here with a chosen colour.
    doc.updateLayer(layer.id, { locks: { ...NO_LOCKS, transparency: true } });
    await run('clear', { color: [0, 0, 255] });
    expect(layer.buffer.getPixel(55, 55)).toEqual([0, 0, 255, 255]);

    doc.setActiveLayer(doc.background!.id);
    doc.background!.buffer.writeRegion({ x: 50, y: 50, w: 1, h: 1 }, new Uint8Array([1, 2, 3]));
    await run('clear');
    expect(doc.background!.buffer.getPixel(50, 50)).toEqual([255, 255, 255]);
  });
});
