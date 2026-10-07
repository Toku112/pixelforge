import { describe, expect, it } from 'vitest';
import { ImageDocument } from '../../../../src/core/document/document';
import { DirtyTracker } from '../../../../src/engine/tiles/dirty-tracker';

function setup() {
  const doc = new ImageDocument({ width: 1000, height: 600 });
  doc.insertLayer(doc.createBackgroundLayer());
  const layer = doc.createPixelLayer();
  doc.insertLayer(layer);
  const tracker = new DirtyTracker(doc);
  tracker.consume(); // start clean
  return { doc, layer, tracker };
}

const sorted = (tiles: [number, number][]) => tiles.map(([x, y]) => `${x},${y}`).sort();

describe('DirtyTracker', () => {
  it('starts fully dirty and is clean after consume()', () => {
    const doc = new ImageDocument({ width: 10, height: 10 });
    const tracker = new DirtyTracker(doc);
    expect(tracker.consume()).toEqual({ all: true, tiles: [] });
    expect(tracker.isDirty).toBe(false);
    expect(tracker.consume()).toEqual({ all: false, tiles: [] });
  });

  it('marks the document tiles touched by pixel changes, including layer offsets, clipped to the canvas', () => {
    const { doc, layer, tracker } = setup();
    doc.updateLayer(layer.id, { offsetX: 200, offsetY: 0 });
    tracker.consume();
    layer.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array(4)); // layer tile (0,0) → doc x 200..455
    expect(sorted(tracker.consume().tiles)).toEqual(['0,0', '1,0']);
    layer.buffer.writeRegion({ x: -2000, y: 0, w: 1, h: 1 }, new Uint8Array(4)); // off-canvas
    expect(tracker.consume().tiles).toEqual([]);
  });

  it('ignores hidden layers until they are shown, then dirties their bounds', () => {
    const { doc, layer, tracker } = setup();
    doc.updateLayer(layer.id, { visible: false });
    tracker.consume();
    layer.buffer.writeRegion({ x: 600, y: 300, w: 1, h: 1 }, new Uint8Array(4));
    expect(tracker.consume().tiles).toEqual([]);
    doc.updateLayer(layer.id, { visible: true });
    expect(sorted(tracker.consume().tiles)).toEqual(['2,1']);
  });

  it('dirties both the old and the new area when a layer moves', () => {
    const { doc, layer, tracker } = setup();
    layer.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array(4));
    tracker.consume();
    doc.updateLayer(layer.id, { offsetX: 512 });
    expect(sorted(tracker.consume().tiles)).toEqual(['0,0', '2,0']);
  });

  it('ignores changes that do not affect the picture (name, expanded, locks)', () => {
    const { doc, layer, tracker } = setup();
    layer.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array(4));
    tracker.consume();
    doc.updateLayer(layer.id, { name: 'Renamed', locks: { ...layer.locks, pixels: true } });
    doc.updateLayer(doc.background!.id, { name: 'Paper' });
    expect(tracker.isDirty).toBe(false);
    doc.updateLayer(layer.id, { opacity: 0.5 });
    expect(sorted(tracker.consume().tiles)).toEqual(['0,0']);
  });

  it('dirties everything on structure, canvas or Background changes', () => {
    const { doc, tracker } = setup();
    doc.insertLayer(doc.createPixelLayer());
    expect(tracker.consume().all).toBe(true);
    doc.setCanvasProps({ resolution: 300 });
    expect(tracker.consume().all).toBe(true);
    doc.updateLayer(doc.background!.id, { visible: false });
    expect(tracker.consume().all).toBe(true);
  });

  it('notifies listeners and stops after dispose()', () => {
    const { layer, tracker } = setup();
    let calls = 0;
    tracker.onDirty(() => calls++);
    layer.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array(4));
    expect(calls).toBe(1);
    tracker.dispose();
    layer.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array(4));
    expect(calls).toBe(1);
  });
});
