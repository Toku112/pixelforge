import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../../../../src/core/commands/command';
import { CommandUnavailableError } from '../../../../src/core/commands/command';
import type { ImageDocument } from '../../../../src/core/document/document';
import { History } from '../../../../src/core/history/history';
import { createContext, withBackground } from '../helpers';

function setup() {
  const env = withBackground(createContext({ width: 300, height: 200 }));
  const history = new History(env.doc);
  const run = (name: string, params: CommandDescriptor['params'] = {}) =>
    history.execute(env.registry.create(env.ctx, { name, params }));
  return { ...env, history, run };
}

/** Layer names as nested arrays, top → bottom (as the Layers panel shows them). */
function tree(doc: ImageDocument, parent = doc.root): unknown[] {
  return [...parent.children].reverse().map((l) => (l.kind === 'group' ? { [l.name]: tree(doc, l) } : l.name));
}

const selectedNames = (doc: ImageDocument) => doc.selectedLayerIds.map((id) => doc.requireLayer(id).name);

describe('New Layer', () => {
  it('adds "Layer N" above the active layer and selects it; undo/redo', async () => {
    const { doc, history, run } = setup();
    await run('newLayer');
    await run('newLayer');
    expect(tree(doc)).toEqual(['Layer 2', 'Layer 1', 'Background']);
    expect(selectedNames(doc)).toEqual(['Layer 2']);
    doc.setActiveLayer(doc.root.children[1]!.id); // Layer 1
    await run('newLayer', { name: 'Sky' });
    expect(tree(doc)).toEqual(['Layer 2', 'Sky', 'Layer 1', 'Background']);
    await history.undo();
    expect(tree(doc)).toEqual(['Layer 2', 'Layer 1', 'Background']);
    expect(selectedNames(doc)).toEqual(['Layer 1']);
    await history.redo();
    expect(tree(doc)).toEqual(['Layer 2', 'Sky', 'Layer 1', 'Background']);
    expect(history.entries.map((e) => e.label)).toEqual(['Open', 'New Layer', 'New Layer', 'New Layer']);
  });

  it('goes inside an expanded active group, above a collapsed one', async () => {
    const { doc, run } = setup();
    await run('newGroup');
    await run('newLayer');
    expect(tree(doc)).toEqual([{ 'Group 1': ['Layer 1'] }, 'Background']);
    await run('newGroup'); // above Layer 1, inside Group 1
    doc.updateLayer(doc.activeLayerId!, { expanded: false });
    await run('newLayer');
    expect(tree(doc)).toEqual([{ 'Group 1': ['Layer 2', { 'Group 2': [] }, 'Layer 1'] }, 'Background']);
  });
});

describe('New Layer and New Group options (dialogs)', () => {
  it('creates layers and groups with a chosen name, blend mode and opacity', async () => {
    const { doc, history, run } = setup();
    await run('newLayer', { name: 'Shadows', blendMode: 'multiply', opacity: 0.4 });
    const layer = doc.activeLayer!;
    expect([layer.name, layer.blendMode, layer.opacity]).toEqual(['Shadows', 'multiply', 0.4]);
    await run('newGroup', { name: 'Looks', blendMode: 'normal', opacity: 0.5 });
    const group = doc.activeLayer!;
    expect([group.kind, group.name, group.blendMode, group.opacity]).toEqual(['group', 'Looks', 'normal', 0.5]);
    await history.undo();
    await history.undo();
    await history.redo();
    expect(doc.activeLayer!.blendMode).toBe('multiply');
  });

  it('groups layers into a group with options, and rejects invalid options', async () => {
    const { doc, run } = setup();
    await run('newLayer');
    await run('groupLayers', { name: 'Set', blendMode: 'screen', opacity: 0.75 });
    expect([doc.activeLayer!.name, doc.activeLayer!.blendMode, doc.activeLayer!.opacity]).toEqual([
      'Set',
      'screen',
      0.75,
    ]);
    // Invalid descriptors are refused when the command is created.
    expect(() => run('newLayer', { blendMode: 'pass-through' })).toThrow('blend mode');
    expect(() => run('newLayer', { opacity: 2 })).toThrow('opacity');
  });

  it('names a single duplicate as asked', async () => {
    const { doc, run } = setup();
    await run('newLayer', { name: 'Sky' });
    await run('duplicateLayers', { name: 'Sky backup' });
    expect(tree(doc)).toEqual(['Sky backup', 'Sky', 'Background']);
    doc.selectLayers(doc.root.children.slice(1).map((l) => l.id));
    await expect(run('duplicateLayers', { name: 'Two' })).rejects.toThrow('single layer');
  });

  it('a group locked with Lock All locks its contents', async () => {
    const { doc, run } = setup();
    await run('newGroup');
    await run('newLayer');
    const child = doc.activeLayer!;
    const group = child.parent!;
    doc.updateLayer(group.id, { locks: { ...group.locks, all: true } });
    expect(() => doc.updateLayer(child.id, { opacity: 0.5 })).toThrow('is locked');
    await expect(run('deleteLayers', { layerIds: [child.id] })).rejects.toThrow('is locked');
  });
});

describe('Delete Layer', () => {
  it('deletes the selected layers, selects the layer below, and undo restores pixels and selection', async () => {
    const { doc, history, run } = setup();
    await run('newLayer');
    const layer = doc.requirePixelLayer(doc.activeLayerId!);
    layer.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([1, 2, 3, 255]));
    await run('newLayer');
    doc.selectLayers([layer.id, doc.activeLayerId!]);
    await run('deleteLayers');
    expect(tree(doc)).toEqual(['Background']);
    expect(selectedNames(doc)).toEqual(['Background']);
    await history.undo();
    expect(tree(doc)).toEqual(['Layer 2', 'Layer 1', 'Background']);
    expect(doc.requirePixelLayer(layer.id).buffer.getPixel(0, 0)).toEqual([1, 2, 3, 255]);
    expect(selectedNames(doc)).toEqual(['Layer 1', 'Layer 2']);
    await history.redo();
    expect(tree(doc)).toEqual(['Background']);
  });

  it('keeps at least one layer and refuses locked layers', async () => {
    const { doc, ctx, registry, run } = setup();
    expect(registry.isAvailable('deleteLayers', ctx)).toBe(false);
    await expect(run('deleteLayers')).rejects.toBeInstanceOf(CommandUnavailableError);
    await run('newLayer');
    doc.updateLayer(doc.activeLayerId!, {
      locks: { transparency: false, pixels: false, position: false, artboardNesting: false, all: true },
    });
    await expect(run('deleteLayers')).rejects.toThrow('is locked');
  });
});

describe('Duplicate Layer', () => {
  it('names copies "copy", "copy 2" and keeps them independent', async () => {
    const { doc, history, run } = setup();
    await run('newLayer');
    const source = doc.requirePixelLayer(doc.activeLayerId!);
    source.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([9, 9, 9, 255]));
    await run('duplicateLayers', { layerIds: [source.id] });
    await run('duplicateLayers', { layerIds: [source.id] });
    // Each duplicate goes directly above its source.
    expect(tree(doc)).toEqual(['Layer 1 copy', 'Layer 1 copy 2', 'Layer 1', 'Background']);
    const copy = doc.requirePixelLayer(doc.activeLayerId!);
    expect(copy.buffer.getPixel(0, 0)).toEqual([9, 9, 9, 255]);
    copy.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([0, 0, 0, 0]));
    expect(source.buffer.getPixel(0, 0)).toEqual([9, 9, 9, 255]);
    await history.undo();
    expect(tree(doc)).toEqual(['Layer 1 copy', 'Layer 1', 'Background']);
    expect(copy.name).toBe('Layer 1 copy 2');
  });

  it('duplicates groups with their children under new ids', async () => {
    const { doc, run } = setup();
    await run('newGroup');
    await run('newLayer');
    const group = doc.root.children[1]!;
    await run('duplicateLayers', { layerIds: [group.id] });
    expect(tree(doc)).toEqual([{ 'Group 1 copy': ['Layer 1'] }, { 'Group 1': ['Layer 1'] }, 'Background']);
    expect(new Set(doc.stackOrder()).size).toBe(doc.layerCount); // all ids unique
  });

  it('turns a duplicated Background into a normal layer with transparency', async () => {
    const { doc, run } = setup();
    await run('duplicateLayers');
    const copy = doc.requirePixelLayer(doc.activeLayerId!);
    expect(copy).toMatchObject({ name: 'Background copy', isBackground: false });
    expect(copy.buffer.format.hasAlpha).toBe(true);
    expect(copy.buffer.getPixel(299, 199)).toEqual([255, 255, 255, 255]);
    expect(copy.buffer.tileCount).toBe(2); // the whole canvas
  });
});

describe('Groups', () => {
  it('groups the selected layers where the topmost was, and undo restores the exact order', async () => {
    const { doc, history, run } = setup();
    for (let i = 0; i < 4; i++) await run('newLayer');
    const [l1, , l3] = doc.root.children.slice(1).map((l) => l.id); // Layer 1 … Layer 4, bottom → top
    doc.selectLayers([l3!, l1!]);
    await run('groupLayers');
    expect(tree(doc)).toEqual(['Layer 4', { 'Group 1': ['Layer 3', 'Layer 1'] }, 'Layer 2', 'Background']);
    expect(selectedNames(doc)).toEqual(['Group 1']);
    await history.undo();
    expect(tree(doc)).toEqual(['Layer 4', 'Layer 3', 'Layer 2', 'Layer 1', 'Background']);
    await history.redo();
    expect(tree(doc)).toEqual(['Layer 4', { 'Group 1': ['Layer 3', 'Layer 1'] }, 'Layer 2', 'Background']);
  });

  it('refuses to group the Background', async () => {
    const { run } = setup();
    await expect(run('groupLayers')).rejects.toThrow('cannot be put in a group');
  });

  it('ungroups, keeping the children in place; undo brings the group back with its properties', async () => {
    const { doc, history, run } = setup();
    await run('newLayer');
    await run('newLayer');
    doc.selectLayers(doc.root.children.slice(1).map((l) => l.id));
    await run('groupLayers');
    const group = doc.requireLayer(doc.activeLayerId!);
    doc.updateLayer(group.id, { opacity: 0.5, name: 'Clouds' });
    await run('ungroup');
    expect(tree(doc)).toEqual(['Layer 2', 'Layer 1', 'Background']);
    expect(selectedNames(doc).sort()).toEqual(['Layer 1', 'Layer 2']);
    await history.undo();
    expect(tree(doc)).toEqual([{ Clouds: ['Layer 2', 'Layer 1'] }, 'Background']);
    expect(doc.requireLayer(group.id).opacity).toBe(0.5);
  });
});

describe('Layer order', () => {
  async function four() {
    const env = setup();
    for (let i = 0; i < 4; i++) await env.run('newLayer');
    const id = (name: string) => [...env.doc.layers()].find((l) => l.name === name)!.id;
    return { ...env, id };
  }

  it('brings forward/to front and sends backward/to back, never below the Background', async () => {
    const { doc, run, id } = await four();
    await run('arrangeLayers', { mode: 'forward', layerIds: [id('Layer 2')] });
    expect(tree(doc)).toEqual(['Layer 4', 'Layer 2', 'Layer 3', 'Layer 1', 'Background']);
    await run('arrangeLayers', { mode: 'front', layerIds: [id('Layer 1')] });
    expect(tree(doc)).toEqual(['Layer 1', 'Layer 4', 'Layer 2', 'Layer 3', 'Background']);
    await run('arrangeLayers', { mode: 'back', layerIds: [id('Layer 4')] });
    expect(tree(doc)).toEqual(['Layer 1', 'Layer 2', 'Layer 3', 'Layer 4', 'Background']);
    await run('arrangeLayers', { mode: 'backward', layerIds: [id('Layer 4')] }); // already lowest above the Background
    expect(tree(doc)).toEqual(['Layer 1', 'Layer 2', 'Layer 3', 'Layer 4', 'Background']);
  });

  it('moves several selected layers as a block and undoes', async () => {
    const { doc, history, run, id } = await four();
    await run('arrangeLayers', { mode: 'forward', layerIds: [id('Layer 1'), id('Layer 2')] });
    expect(tree(doc)).toEqual(['Layer 4', 'Layer 2', 'Layer 1', 'Layer 3', 'Background']);
    await history.undo();
    expect(tree(doc)).toEqual(['Layer 4', 'Layer 3', 'Layer 2', 'Layer 1', 'Background']);
  });

  it('moves layers to a position in another group (dragging in the Layers panel)', async () => {
    const { doc, history, run, id } = await four();
    await run('newGroup');
    const g = doc.activeLayerId!;
    await run('moveLayers', { layerIds: [id('Layer 1'), id('Layer 3')], parentId: g, index: 0 });
    expect(tree(doc)).toEqual([{ 'Group 1': ['Layer 3', 'Layer 1'] }, 'Layer 4', 'Layer 2', 'Background']);
    await run('moveLayers', { layerIds: [id('Layer 4')], parentId: 'root', index: 1 }); // just above the Background
    expect(tree(doc)).toEqual([{ 'Group 1': ['Layer 3', 'Layer 1'] }, 'Layer 2', 'Layer 4', 'Background']);
    await expect(run('moveLayers', { layerIds: [g], parentId: g, index: 0 })).rejects.toThrow('into itself');
    await history.undo();
    await history.undo();
    expect(tree(doc)).toEqual([{ 'Group 1': [] }, 'Layer 4', 'Layer 3', 'Layer 2', 'Layer 1', 'Background']);
  });
});

describe('Layer from Background', () => {
  it('turns the Background into "Layer 0" with transparency, keeping its pixels and id', async () => {
    const { doc, history, run } = setup();
    const bg = doc.background!;
    bg.buffer.writeRegion({ x: 5, y: 5, w: 1, h: 1 }, new Uint8Array([10, 20, 30]));
    await run('layerFromBackground');
    const layer = doc.requirePixelLayer(bg.id);
    expect(layer).toMatchObject({ name: 'Layer 0', isBackground: false });
    expect(doc.background).toBeUndefined();
    expect(layer.buffer.getPixel(5, 5)).toEqual([10, 20, 30, 255]);
    expect(layer.buffer.getPixel(250, 150)).toEqual([255, 255, 255, 255]);
    doc.updateLayer(layer.id, { opacity: 0.5, offsetX: 3 }); // now allowed
    await history.undo();
    expect(doc.background?.buffer.getPixel(5, 5)).toEqual([10, 20, 30]);
    await history.redo();
    expect(doc.requirePixelLayer(bg.id).buffer.format.hasAlpha).toBe(true);
  });
});

describe('Robustness', () => {
  it('replays recorded descriptors on a fresh document with the same result', async () => {
    const a = setup();
    const commands: { name: string; params: Record<string, string> }[] = [
      { name: 'newLayer', params: {} },
      { name: 'newLayer', params: { name: 'Top' } },
      { name: 'duplicateLayers', params: {} },
      { name: 'newGroup', params: {} },
      { name: 'arrangeLayers', params: { mode: 'back' } },
      { name: 'layerFromBackground', params: {} },
    ];
    for (const c of commands) await a.run(c.name, c.params);
    const b = setup();
    for (const c of JSON.parse(JSON.stringify(commands)) as typeof commands) await b.run(c.name, c.params);
    expect(tree(b.doc)).toEqual(tree(a.doc));
    expect(tree(a.doc)).toEqual(['Top copy', 'Top', 'Layer 1', { 'Group 1': [] }, 'Layer 0']);
  });

  it('survives undo/redo across a history snapshot restore', async () => {
    const env = withBackground(createContext());
    const history = new History(env.doc, { maxStates: 2 });
    const run = (name: string) => history.execute(env.registry.create(env.ctx, { name, params: {} }));
    await run('newLayer');
    await run('layerFromBackground');
    await run('duplicateLayers');
    await history.goTo(0); // snapshot jump (oldest state was dropped)
    expect(tree(env.doc)).toEqual(['Background']);
    await history.goTo(2);
    expect(tree(env.doc)).toEqual(['Layer 1', 'Layer 0 copy', 'Layer 0']);
    await history.goTo(1);
    expect(tree(env.doc)).toEqual(['Layer 1', 'Layer 0']);
    await history.goTo(2);
    expect(tree(env.doc)).toEqual(['Layer 1', 'Layer 0 copy', 'Layer 0']);
  });
});
