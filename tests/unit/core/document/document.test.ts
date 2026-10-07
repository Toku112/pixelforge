import { describe, expect, it } from 'vitest';
import { ImageDocument, type DocumentChange } from '../../../../src/core/document/document';
import { layerCapabilities, LAYER_BLEND_MODES, NO_LOCKS } from '../../../../src/core/document/layers';

function docWithBackground(init: Partial<ConstructorParameters<typeof ImageDocument>[0]> = {}) {
  const doc = new ImageDocument({ width: 640, height: 480, ...init });
  doc.insertLayer(doc.createBackgroundLayer());
  return doc;
}

describe('ImageDocument', () => {
  it('validates canvas size', () => {
    expect(() => new ImageDocument({ width: 0, height: 10 })).toThrow('width');
    expect(() => new ImageDocument({ width: 10, height: 300_001 })).toThrow('height');
    expect(() => new ImageDocument({ width: 1.5, height: 10 })).toThrow('width');
    expect(new ImageDocument({ width: 300_000, height: 1 }).width).toBe(300_000);
  });

  it('derives layer formats from colour mode and bit depth', () => {
    expect(new ImageDocument({ width: 1, height: 1 }).layerFormat()).toEqual({
      depth: 8,
      colorChannels: 3,
      hasAlpha: true,
    });
    expect(new ImageDocument({ width: 1, height: 1, mode: 'cmyk', depth: 16 }).layerFormat(false)).toEqual({
      depth: 16,
      colorChannels: 4,
      hasAlpha: false,
    });
    expect(new ImageDocument({ width: 1, height: 1, mode: 'grayscale', depth: 32 }).colorChannels).toBe(1);
    expect(new ImageDocument({ width: 1, height: 1, mode: 'multichannel', multichannelCount: 5 }).colorChannels).toBe(
      5,
    );
  });

  it('knows white in each colour mode', () => {
    const white = (init: Partial<ConstructorParameters<typeof ImageDocument>[0]>) =>
      new ImageDocument({ width: 1, height: 1, ...init }).whitePixel();
    expect(white({})).toEqual([255, 255, 255]);
    expect(white({ depth: 16 })).toEqual([65535, 65535, 65535]);
    expect(white({ depth: 32 })).toEqual([1, 1, 1]);
    expect(white({ mode: 'cmyk' })).toEqual([0, 0, 0, 0]);
    expect(white({ mode: 'lab' })).toEqual([255, 128, 128]);
    expect(white({ mode: 'lab', depth: 16 })).toEqual([65535, 32768, 32768]);
    expect(white({ mode: 'grayscale' })).toEqual([255]);
  });

  it('creates a white, opaque Background layer without allocating tiles', () => {
    const doc = docWithBackground();
    const bg = doc.background!;
    expect(bg.name).toBe('Background');
    expect(bg.isBackground).toBe(true);
    expect(bg.buffer.format.hasAlpha).toBe(false);
    expect(bg.buffer.getPixel(100, 100)).toEqual([255, 255, 255]);
    expect(bg.buffer.tileCount).toBe(0);
  });

  it('assigns deterministic layer ids and default names', () => {
    const doc = docWithBackground();
    const a = doc.createPixelLayer();
    const b = doc.createPixelLayer();
    expect([a.id, b.id]).toEqual(['L2', 'L3']);
    expect([a.name, b.name]).toEqual(['Layer 1', 'Layer 2']);
  });

  it('keeps layers bottom → top and iterates groups depth first', () => {
    const doc = docWithBackground();
    const a = doc.createPixelLayer('A');
    const g = doc.createGroup('G');
    const b = doc.createPixelLayer('B');
    doc.insertLayer(a);
    doc.insertLayer(g);
    doc.insertLayer(b, g.id);
    expect(doc.root.children.map((l) => l.name)).toEqual(['Background', 'A', 'G']);
    expect([...doc.layers()].map((l) => l.name)).toEqual(['Background', 'A', 'G', 'B']);
    expect(doc.getLayer(b.id)?.parent).toBe(g);
    expect(doc.layerCount).toBe(4);
  });

  it('enforces Background placement rules', () => {
    const doc = docWithBackground();
    expect(() => doc.insertLayer(doc.createBackgroundLayer())).toThrow(
      /Background layer must be the bottom|only have one/,
    );
    expect(() => doc.insertLayer(doc.createPixelLayer(), doc.root.id, 0)).toThrow('below the Background');
    const empty = new ImageDocument({ width: 10, height: 10 });
    empty.insertLayer(empty.createPixelLayer());
    expect(() => empty.insertLayer(empty.createBackgroundLayer(), empty.root.id, 1)).toThrow('must be the bottom');
    empty.insertLayer(empty.createBackgroundLayer(), empty.root.id, 0);
    expect(empty.background?.name).toBe('Background');
  });

  it('enforces Background property rules', () => {
    const doc = docWithBackground();
    const id = doc.background!.id;
    expect(() => doc.updateLayer(id, { opacity: 0.5 })).toThrow('fully opaque');
    expect(() => doc.updateLayer(id, { blendMode: 'multiply' })).toThrow('Normal blend mode');
    expect(() => doc.updateLayer(id, { offsetX: 3 })).toThrow('cannot be moved');
    expect(doc.updateLayer(id, { name: 'Paper', visible: false })).toEqual({ name: 'Background', visible: true });
    expect(layerCapabilities(doc.background!)).toMatchObject({ move: false, reorder: false, changeOpacity: false });
  });

  it('Lock All fixes opacity, fill and blend mode; Pass Through is for groups only', () => {
    const doc = docWithBackground();
    const layer = doc.createPixelLayer('Locked');
    doc.insertLayer(layer);
    doc.updateLayer(layer.id, { locks: { ...NO_LOCKS, all: true } });
    expect(() => doc.updateLayer(layer.id, { opacity: 0.5 })).toThrow('"Locked" is locked');
    expect(() => doc.updateLayer(layer.id, { fillOpacity: 0.5 })).toThrow('is locked');
    expect(() => doc.updateLayer(layer.id, { blendMode: 'screen' })).toThrow('is locked');
    expect(doc.updateLayer(layer.id, { blendMode: 'normal', opacity: 1 })).toEqual({ blendMode: 'normal', opacity: 1 });
    doc.updateLayer(layer.id, { locks: NO_LOCKS });
    expect(doc.updateLayer(layer.id, { blendMode: 'screen' })).toEqual({ blendMode: 'normal' });
    expect(() => doc.updateLayer(layer.id, { blendMode: 'pass-through' })).toThrow('groups only');
    const group = doc.createGroup();
    doc.insertLayer(group);
    expect(doc.updateLayer(group.id, { blendMode: 'multiply' })).toEqual({ blendMode: 'pass-through' });
    expect(doc.updateLayer(group.id, { blendMode: 'pass-through' })).toEqual({ blendMode: 'multiply' });
  });

  it('updates layer properties, returning previous values for undo', () => {
    const doc = docWithBackground();
    const layer = doc.createPixelLayer();
    doc.insertLayer(layer);
    const prev = doc.updateLayer(layer.id, { opacity: 0.25, blendMode: 'screen', offsetX: -12 });
    expect(prev).toEqual({ opacity: 1, blendMode: 'normal', offsetX: 0 });
    expect(layer).toMatchObject({ opacity: 0.25, blendMode: 'screen', offsetX: -12 });
    doc.updateLayer(layer.id, prev);
    expect(layer).toMatchObject({ opacity: 1, blendMode: 'normal', offsetX: 0 });
    expect(() => doc.updateLayer(layer.id, { opacity: 2 })).toThrow('between 0 and 1');
    expect(() => doc.updateLayer(layer.id, { offsetX: 0.5 })).toThrow('whole pixels');
    expect(() => doc.updateLayer(layer.id, { expanded: false })).toThrow('no property expanded');
  });

  it('removes layers with their children and reports where they were', () => {
    const doc = docWithBackground();
    const g = doc.createGroup();
    const child = doc.createPixelLayer();
    doc.insertLayer(g);
    doc.insertLayer(child, g.id);
    doc.setActiveLayer(child.id);
    const removed = doc.removeLayer(g.id);
    expect(removed).toMatchObject({ parentId: 'root', index: 1, layer: g });
    expect(doc.getLayer(child.id)).toBeUndefined();
    expect(doc.activeLayerId).toBeNull();
    // Re-inserting restores the subtree.
    doc.insertLayer(removed.layer, removed.parentId, removed.index);
    expect(doc.getLayer(child.id)?.parent).toBe(g);
  });

  it('emits change events, including pixel changes in document coordinates', () => {
    const doc = docWithBackground();
    const layer = doc.createPixelLayer();
    const events: DocumentChange[] = [];
    doc.changes.on((e) => events.push(e));
    doc.insertLayer(layer);
    doc.updateLayer(layer.id, { offsetX: 10, offsetY: -20 });
    layer.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([1, 2, 3, 4]));
    doc.setActiveLayer(layer.id);
    expect(events).toEqual([
      { kind: 'structure' },
      { kind: 'layer', layerId: layer.id, props: ['offsetX', 'offsetY'] },
      { kind: 'pixels', layerId: layer.id, rect: { x: 10, y: -20, w: 256, h: 256 } },
      { kind: 'active-layer', layerId: layer.id },
    ]);
    // Removed layers stop reporting.
    doc.removeLayer(layer.id);
    events.length = 0;
    layer.buffer.markChanged(0, 0);
    expect(events).toEqual([]);
  });

  it('rejects layers whose pixel format does not match the document', () => {
    const doc8 = new ImageDocument({ width: 10, height: 10 });
    const doc16 = new ImageDocument({ width: 10, height: 10, depth: 16 });
    expect(() => doc16.insertLayer(doc8.createPixelLayer())).toThrow('pixel format');
  });

  it('lists all 27 layer blend modes', () => {
    expect(LAYER_BLEND_MODES).toHaveLength(27);
    expect(new Set(LAYER_BLEND_MODES).size).toBe(27);
  });
});

describe('ImageDocument tile attachment', () => {
  it('attaches layer buffers on insert and detaches them on remove', () => {
    const doc = new ImageDocument({ width: 10, height: 10 });
    const layer = doc.createPixelLayer();
    const tile = layer.buffer.writableTile(0, 0);
    doc.insertLayer(layer);
    expect(layer.buffer.attached).toBe(true);
    expect(tile.attachedRefs).toBe(1);
    doc.removeLayer(layer.id);
    expect(layer.buffer.attached).toBe(false);
    expect(tile.attachedRefs).toBe(0);
  });

  it('refuses layers whose pixels are not in memory, without changing the tree', () => {
    const doc = new ImageDocument({ width: 10, height: 10 });
    const layer = doc.createPixelLayer();
    const tile = layer.buffer.writableTile(0, 0);
    layer.buffer.captureTile(0, 0);
    tile.release();
    expect(() => doc.insertLayer(layer)).toThrow('not in memory');
    expect(doc.layerCount).toBe(0);
    expect(doc.root.children).toHaveLength(0);
  });
});

describe('ImageDocument layer selection and moves', () => {
  it('selects several layers with an active one; removing layers updates the selection', () => {
    const doc = docWithBackground();
    const a = doc.createPixelLayer();
    const b = doc.createPixelLayer();
    doc.insertLayer(a);
    doc.insertLayer(b);
    doc.selectLayers([a.id, b.id], a.id);
    expect(doc.selectedLayerIds).toEqual([a.id, b.id]);
    expect(doc.activeLayerId).toBe(a.id);
    expect(() => doc.selectLayers([a.id], b.id)).toThrow('not selected');
    expect(() => doc.selectLayers(['nope'])).toThrow('No layer');
    doc.removeLayer(a.id);
    expect(doc.selectedLayerIds).toEqual([b.id]);
    expect(doc.activeLayerId).toBe(b.id);
  });

  it('moves layers, refusing the Background, moving a group into itself, or going below the Background', () => {
    const doc = docWithBackground();
    const g = doc.createGroup();
    const a = doc.createPixelLayer();
    doc.insertLayer(g);
    doc.insertLayer(a);
    expect(doc.moveLayer(a.id, g.id, 0)).toEqual({ parentId: 'root', index: 2 });
    expect(doc.positionOf(a.id)).toEqual({ parentId: g.id, index: 0 });
    expect(() => doc.moveLayer(doc.background!.id, 'root', 1)).toThrow('cannot be moved');
    expect(() => doc.moveLayer(g.id, g.id, 0)).toThrow('into itself');
    expect(() => doc.moveLayer(g.id, 'root', 0)).toThrow('below the Background');
    expect(doc.positionOf(g.id)).toEqual({ parentId: 'root', index: 1 }); // unchanged after the failed move
    expect(doc.isWithin(a.id, g.id)).toBe(true);
  });
});
