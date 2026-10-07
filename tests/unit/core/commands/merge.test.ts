import { describe, expect, it } from 'vitest';
import { compositeToSamples, flatten, planFromDocument } from '../../../../src/core/composite/flatten';
import type { CommandDescriptor } from '../../../../src/core/commands/command';
import type { ImageDocument } from '../../../../src/core/document/document';
import { NO_LOCKS, type LayerNode, type PixelLayer } from '../../../../src/core/document/layers';
import { History } from '../../../../src/core/history/history';
import { createContext, withBackground } from '../helpers';

function setup(background = true) {
  const env = createContext({ width: 300, height: 200 });
  if (background) withBackground(env);
  const history = new History(env.doc);
  const run = (name: string, params: CommandDescriptor['params'] = {}) =>
    history.execute(env.registry.create(env.ctx, { name, params }));
  const available = (name: string) => env.registry.isAvailable(name, env.ctx);
  return { ...env, history, run, available };
}

/** Adds a layer with `rgba` (0–255) painted over `rect`. */
function addLayer(
  doc: ImageDocument,
  name: string,
  rect: { x: number; y: number; w: number; h: number },
  rgba: number[],
  parentId?: string,
): PixelLayer {
  const layer = doc.createPixelLayer(name);
  doc.insertLayer(layer, parentId);
  const data = new Uint8Array(rect.w * rect.h * 4);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i % 4]!;
  layer.buffer.writeRegion(rect, data);
  doc.setActiveLayer(layer.id);
  return layer;
}

/** The document as it looks (8-bit straight RGBA over the canvas). */
const appearance = (doc: ImageDocument) => compositeToSamples(flatten(planFromDocument(doc)), 8, true);

function expectSameLook(a: ArrayLike<number>, b: ArrayLike<number>) {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  expect(max).toBeLessThanOrEqual(1); // one rounding step for the merged intermediate
}

/** Layer names top → bottom as the Layers panel lists them (a group, then its contents). */
function names(doc: ImageDocument, parent: { children: readonly LayerNode[] } = doc.root): string[] {
  return [...parent.children].reverse().flatMap((l) => (l.kind === 'group' ? [l.name, ...names(doc, l)] : [l.name]));
}

describe('Merge Down', () => {
  it('bakes the layer into the one below, keeping the lower layer’s name and properties; undo restores both', async () => {
    const { doc, history, run } = setup();
    const base = addLayer(doc, 'Base', { x: 0, y: 0, w: 120, h: 80 }, [200, 100, 50, 255]);
    doc.updateLayer(base.id, { blendMode: 'screen', opacity: 0.8 });
    const top = addLayer(doc, 'Top', { x: 60, y: 40, w: 120, h: 80 }, [20, 40, 220, 128]);
    doc.updateLayer(top.id, { blendMode: 'multiply', opacity: 0.5 });
    await run('mergeLayers');
    expect(names(doc)).toEqual(['Base', 'Background']);
    const merged = doc.activeLayer as PixelLayer;
    expect([merged.id, merged.blendMode, merged.opacity]).toEqual([base.id, 'screen', 0.8]);
    expect(history.entries.at(-1)!.label).toBe('Merge Down');
    // Inside the overlap: Top multiplied onto Base's own colour at 50 %.
    const p = merged.buffer.getPixel(80, 50);
    expect(p).toEqual([
      Math.round(200 * (1 - 0.25) + 200 * (20 / 255) * 0.25),
      100 - Math.round(100 * 0.25 * (1 - 40 / 255)),
      Math.round(50 * 0.75 + 50 * (220 / 255) * 0.25),
      255,
    ]);
    await history.undo();
    expect(names(doc)).toEqual(['Top', 'Base', 'Background']);
    expect(doc.activeLayerId).toBe(top.id);
    expect(doc.requirePixelLayer(top.id).buffer.getPixel(70, 50)).toEqual([20, 40, 220, 128]);
    await history.redo();
    expect(names(doc)).toEqual(['Base', 'Background']);
  });

  it('keeps the look with Normal layers, keeps pixels outside the canvas, and merges into the Background', async () => {
    const { doc, run } = setup();
    const a = addLayer(doc, 'A', { x: -40, y: 10, w: 100, h: 50 }, [10, 200, 30, 255]);
    addLayer(doc, 'B', { x: 20, y: 20, w: 100, h: 100 }, [250, 0, 0, 100]);
    const before = appearance(doc);
    await run('mergeLayers');
    expectSameLook(appearance(doc), before);
    expect(doc.requirePixelLayer(a.id).buffer.getPixel(-30, 20)).toEqual([10, 200, 30, 255]);
    await run('mergeLayers'); // A into the Background
    expect(names(doc)).toEqual(['Background']);
    expect(doc.background!.buffer.format.hasAlpha).toBe(false);
    expectSameLook(appearance(doc), before);
  });

  it('is not available on the bottom layer of a group, over a hidden or locked layer', () => {
    const { doc, available } = setup();
    const g = doc.createGroup('G');
    doc.insertLayer(g);
    addLayer(doc, 'Inside', { x: 0, y: 0, w: 1, h: 1 }, [1, 1, 1, 255], g.id);
    expect(available('mergeLayers')).toBe(false);
    const below = addLayer(doc, 'Below', { x: 0, y: 0, w: 1, h: 1 }, [1, 1, 1, 255]);
    addLayer(doc, 'Above', { x: 0, y: 0, w: 1, h: 1 }, [1, 1, 1, 255]);
    expect(available('mergeLayers')).toBe(true);
    doc.updateLayer(below.id, { visible: false });
    expect(available('mergeLayers')).toBe(false);
    doc.updateLayer(below.id, { visible: true, locks: { ...NO_LOCKS, pixels: true } });
    expect(available('mergeLayers')).toBe(false);
  });
});

describe('Merge Layers and Merge Group', () => {
  it('merges the selected layers into one Normal layer named after the topmost; hidden ones are discarded', async () => {
    const { doc, history, run } = setup();
    const a = addLayer(doc, 'A', { x: 0, y: 0, w: 100, h: 100 }, [255, 0, 0, 255]);
    const hidden = addLayer(doc, 'Hidden', { x: 0, y: 0, w: 300, h: 200 }, [0, 0, 0, 255]);
    doc.updateLayer(hidden.id, { visible: false });
    const keep = addLayer(doc, 'Keep', { x: 0, y: 0, w: 10, h: 10 }, [0, 0, 255, 255]);
    const c = addLayer(doc, 'C', { x: 50, y: 50, w: 100, h: 100 }, [0, 255, 0, 128]);
    doc.updateLayer(c.id, { opacity: 0.5 });
    doc.selectLayers([a.id, hidden.id, c.id]);
    await run('mergeLayers');
    expect(history.entries.at(-1)!.label).toBe('Merge Layers');
    expect(names(doc)).toEqual(['C', 'Keep', 'Background']);
    const merged = doc.activeLayer as PixelLayer;
    expect([merged.blendMode, merged.opacity]).toEqual(['normal', 1]);
    expect(merged.buffer.getPixel(10, 10)).toEqual([255, 0, 0, 255]);
    expect(doc.getLayer(keep.id)).toBeDefined();
    await history.undo();
    expect(names(doc)).toEqual(['C', 'Keep', 'Hidden', 'A', 'Background']);
  });

  it('turns a group into one layer with its name, opacity and blend mode, keeping the look', async () => {
    const { doc, run } = setup();
    const g = doc.createGroup('Looks');
    doc.insertLayer(g);
    doc.updateLayer(g.id, { blendMode: 'multiply', opacity: 0.6 });
    addLayer(doc, 'One', { x: 0, y: 0, w: 200, h: 100 }, [255, 128, 0, 255], g.id);
    addLayer(doc, 'Two', { x: 100, y: 50, w: 150, h: 120 }, [0, 128, 255, 160], g.id);
    doc.setActiveLayer(g.id);
    const before = appearance(doc);
    await run('mergeLayers');
    expect(names(doc)).toEqual(['Looks', 'Background']);
    const merged = doc.activeLayer!;
    expect([merged.kind, merged.blendMode, merged.opacity]).toEqual(['pixel', 'multiply', 0.6]);
    expectSameLook(appearance(doc), before);
  });
});

describe('Merge Visible, Stamp Visible, Flatten Image', () => {
  it('Merge Visible merges into the visible Background and leaves hidden layers alone', async () => {
    const { doc, run } = setup();
    addLayer(doc, 'A', { x: 0, y: 0, w: 100, h: 100 }, [255, 0, 0, 200]);
    const hidden = addLayer(doc, 'Hidden', { x: 0, y: 0, w: 300, h: 200 }, [0, 0, 0, 255]);
    doc.updateLayer(hidden.id, { visible: false });
    const g = doc.createGroup('G');
    doc.insertLayer(g);
    addLayer(doc, 'In', { x: 50, y: 50, w: 100, h: 100 }, [0, 0, 255, 255], g.id);
    const hiddenInside = addLayer(doc, 'Hidden inside', { x: 0, y: 0, w: 5, h: 5 }, [0, 0, 0, 255], g.id);
    doc.updateLayer(hiddenInside.id, { visible: false });
    const before = appearance(doc);
    await run('mergeVisible');
    expect(names(doc)).toEqual(['G', 'Hidden inside', 'Hidden', 'Background']);
    expectSameLook(appearance(doc), before);
  });

  it('Merge Visible without a Background makes one layer named after the active layer', async () => {
    const { doc, run } = setup(false);
    addLayer(doc, 'A', { x: 0, y: 0, w: 100, h: 100 }, [255, 0, 0, 200]);
    const b = addLayer(doc, 'B', { x: 50, y: 0, w: 100, h: 100 }, [0, 255, 0, 100]);
    addLayer(doc, 'C', { x: 0, y: 50, w: 100, h: 100 }, [0, 0, 255, 255]);
    doc.setActiveLayer(b.id);
    const before = appearance(doc);
    await run('mergeVisible');
    expect(names(doc)).toEqual(['B']);
    expectSameLook(appearance(doc), before);
  });

  it('Stamp Visible adds the visible image as a new layer above the active one', async () => {
    const { doc, history, run } = setup();
    const a = addLayer(doc, 'A', { x: 0, y: 0, w: 100, h: 100 }, [255, 0, 0, 255]);
    addLayer(doc, 'B', { x: 50, y: 50, w: 100, h: 100 }, [0, 0, 255, 128]);
    doc.setActiveLayer(a.id);
    const before = appearance(doc);
    await run('stampVisible');
    expect(names(doc)).toEqual(['B', 'Layer 1', 'A', 'Background']);
    expect(history.entries.at(-1)!.label).toBe('Stamp Visible');
    const stamp = doc.activeLayer as PixelLayer;
    expect(stamp.buffer.getPixel(75, 75)).toEqual([...before.slice((75 * 300 + 75) * 4, (75 * 300 + 75) * 4 + 4)]);
    await history.undo();
    expect(names(doc)).toEqual(['B', 'A', 'Background']);
  });

  it('Flatten Image makes a white-backed Background and discards hidden layers', async () => {
    const { doc, history, run, available } = setup(false);
    addLayer(doc, 'A', { x: 0, y: 0, w: 100, h: 100 }, [255, 0, 0, 128]);
    const hidden = addLayer(doc, 'Hidden', { x: 0, y: 0, w: 300, h: 200 }, [0, 0, 0, 255]);
    doc.updateLayer(hidden.id, { visible: false });
    await run('flattenImage');
    expect(names(doc)).toEqual(['Background']);
    const bg = doc.background!;
    expect(bg.buffer.getPixel(10, 10)).toEqual([255, 127, 127]);
    expect(bg.buffer.getPixel(200, 150)).toEqual([255, 255, 255]);
    expect(available('flattenImage')).toBe(false); // already flat
    await history.undo();
    expect(names(doc)).toEqual(['Hidden', 'A']);
  });
});

describe('Background from Layer', () => {
  it('moves the layer to the bottom as the Background, filling transparency with the colour', async () => {
    const { doc, history, run, available } = setup(false);
    const a = addLayer(doc, 'A', { x: 0, y: 0, w: 100, h: 100 }, [255, 0, 0, 255]);
    const b = addLayer(doc, 'B', { x: 0, y: 0, w: 50, h: 50 }, [0, 0, 255, 128]);
    expect(available('backgroundFromLayer')).toBe(true);
    await run('backgroundFromLayer', { color: [0, 0, 0] });
    expect(names(doc)).toEqual(['A', 'Background']);
    const bg = doc.background!;
    expect(bg.id).toBe(b.id);
    expect(bg.buffer.getPixel(10, 10)).toEqual([0, 0, 128]);
    expect(bg.buffer.getPixel(200, 150)).toEqual([0, 0, 0]);
    expect(doc.getLayer(a.id)).toBeDefined();
    expect(available('backgroundFromLayer')).toBe(false); // there is a Background now
    await history.undo();
    expect(names(doc)).toEqual(['B', 'A']);
  });
});
