import { describe, expect, it } from 'vitest';
import { captureDocumentState, restoreDocumentState } from '../../../../src/core/history/snapshot';
import { createContext, withBackground } from '../helpers';

describe('document snapshots', () => {
  it('restores layers, properties, pixels and the active layer, and stays reusable', () => {
    const { doc } = withBackground(createContext());
    const group = doc.createGroup('G');
    const layer = doc.createPixelLayer('Paint');
    doc.insertLayer(group);
    doc.insertLayer(layer, group.id);
    layer.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([9, 8, 7, 255]));
    doc.updateLayer(layer.id, { opacity: 0.3, offsetX: 5 });
    doc.setActiveLayer(layer.id);
    const state = captureDocumentState(doc);

    // Change everything.
    layer.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([0, 0, 0, 0]));
    doc.updateLayer(layer.id, { opacity: 1 });
    doc.removeLayer(group.id);

    for (let round = 0; round < 2; round++) {
      restoreDocumentState(doc, state);
      expect([...doc.layers()].map((l) => [l.id, l.name])).toEqual([
        [doc.background!.id, 'Background'],
        [group.id, 'G'],
        [layer.id, 'Paint'],
      ]);
      const restored = doc.requirePixelLayer(layer.id);
      expect(restored).not.toBe(layer); // a fresh copy
      expect(restored.buffer.getPixel(0, 0)).toEqual([9, 8, 7, 255]);
      expect(restored).toMatchObject({ opacity: 0.3, offsetX: 5 });
      expect(doc.activeLayerId).toBe(layer.id);
      restored.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([1, 1, 1, 1])); // must not leak into the snapshot
    }
  });

  it('restores canvas properties', () => {
    const { doc } = withBackground(createContext());
    const state = captureDocumentState(doc);
    doc.setCanvasProps({ width: 50, resolution: 300 });
    restoreDocumentState(doc, state);
    expect(doc.canvasProps()).toMatchObject({ width: 300, height: 200, resolution: 72 });
  });

  it('refuses colour mode or depth changes while layers exist', () => {
    const { doc } = withBackground(createContext());
    expect(() => doc.setCanvasProps({ depth: 16 })).toThrow('Remove all layers');
    expect(() => doc.setCanvasProps({ width: 0 })).toThrow('width');
  });
});
