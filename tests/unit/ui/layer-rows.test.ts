import { describe, expect, it } from 'vitest';
import { ImageDocument } from '../../../src/core/document/document';
import { NO_LOCKS, type LayerNode } from '../../../src/core/document/layers';
import {
  dropPlacement,
  isSoloState,
  layerRows,
  restoreVisibility,
  rowRange,
  soloChanges,
  toggleSelection,
} from '../../../src/ui/panels/layers/layer-rows';

/** Background, A, group G { B, C }, D — as the panel shows: D, G, C, B, A, Background. */
function setup() {
  const doc = new ImageDocument({ width: 10, height: 10 });
  const add = <T extends LayerNode>(layer: T, parent?: string) => (doc.insertLayer(layer, parent), layer);
  const bg = add(doc.createBackgroundLayer());
  const a = add(doc.createPixelLayer('A'));
  const g = add(doc.createGroup('G'));
  const b = add(doc.createPixelLayer('B'), g.id);
  const c = add(doc.createPixelLayer('C'), g.id);
  const d = add(doc.createPixelLayer('D'));
  return { doc, bg, a, g, b, c, d };
}

const names = (doc: ImageDocument) => layerRows(doc).map((r) => `${'  '.repeat(r.depth)}${r.layer.name}`);
const apply = (doc: ImageDocument, changes: { layerId: string; props: { visible: boolean } }[]) => {
  for (const ch of changes) doc.updateLayer(ch.layerId, ch.props);
};

describe('Layers panel rows', () => {
  it('lists layers top to bottom with depth; collapsed groups hide their contents', () => {
    const { doc, g } = setup();
    expect(names(doc)).toEqual(['D', 'G', '  C', '  B', 'A', 'Background']);
    doc.updateLayer(g.id, { expanded: false });
    expect(names(doc)).toEqual(['D', 'G', 'A', 'Background']);
  });

  it('marks selection, hidden groups and locks (own or inherited)', () => {
    const { doc, g, b, c } = setup();
    doc.selectLayers([b.id, c.id], c.id);
    doc.updateLayer(g.id, { visible: false, locks: { ...NO_LOCKS, all: true } });
    doc.updateLayer(c.id, { locks: { ...NO_LOCKS, pixels: true } });
    const rows = layerRows(doc);
    const row = (id: string) => rows.find((r) => r.layer.id === id)!;
    expect([row(b.id).selected, row(b.id).active, row(c.id).active]).toEqual([true, false, true]);
    expect([row(g.id).shown, row(b.id).shown]).toEqual([true, false]);
    expect([row(g.id).lock, row(g.id).lockInherited]).toEqual(['all', false]);
    expect([row(b.id).lock, row(b.id).lockInherited]).toEqual(['all', true]);
    expect([row(c.id).lock, row(c.id).lockInherited]).toEqual(['partial', false]);
  });
});

describe('Layers panel selection', () => {
  it('Shift-click selects the shown range; Ctrl/Cmd-click toggles', () => {
    const { doc, a, b, d } = setup();
    expect(rowRange(layerRows(doc), d.id, b.id).map((id) => doc.requireLayer(id).name)).toEqual(['D', 'G', 'C', 'B']);
    expect(rowRange(layerRows(doc), a.id, a.id)).toEqual([a.id]);
    expect(toggleSelection([a.id], a.id, d.id)).toEqual({ ids: [a.id, d.id], active: d.id });
    expect(toggleSelection([a.id, d.id], d.id, d.id)).toEqual({ ids: [a.id], active: a.id });
    expect(toggleSelection([a.id, d.id], a.id, d.id)).toEqual({ ids: [a.id], active: a.id });
  });
});

describe('Layers panel drag and drop', () => {
  it('drops above/below rows and into groups', () => {
    const { doc, a, g, b, c, d } = setup();
    // D above A → index above A among the root's other children [Background, A, G].
    expect(dropPlacement(doc, [d.id], a.id, 'above')).toEqual({ parentId: doc.root.id, index: 2 });
    expect(dropPlacement(doc, [d.id], a.id, 'below')).toEqual({ parentId: doc.root.id, index: 1 });
    // Into the group: on its middle, or just below an expanded group row (= top of its contents).
    expect(dropPlacement(doc, [a.id], g.id, 'inside')).toEqual({ parentId: g.id, index: 2 });
    expect(dropPlacement(doc, [a.id], g.id, 'below')).toEqual({ parentId: g.id, index: 2 });
    expect(dropPlacement(doc, [a.id], c.id, 'below')).toEqual({ parentId: g.id, index: 1 });
    // Out of the group, above it.
    expect(dropPlacement(doc, [b.id], g.id, 'above')).toEqual({ parentId: doc.root.id, index: 3 });
    doc.updateLayer(g.id, { expanded: false });
    expect(dropPlacement(doc, [a.id], g.id, 'below')).toEqual({ parentId: doc.root.id, index: 1 });
  });

  it('refuses drops below the Background, onto itself or into its own contents', () => {
    const { doc, bg, a, g, b } = setup();
    expect(dropPlacement(doc, [a.id], bg.id, 'below')).toBeNull();
    expect(dropPlacement(doc, [a.id], a.id, 'above')).toBeNull();
    expect(dropPlacement(doc, [g.id], b.id, 'above')).toBeNull();
    expect(dropPlacement(doc, [g.id], g.id, 'inside')).toBeNull();
    expect(dropPlacement(doc, [b.id], a.id, 'inside')).toBeNull(); // not a group
  });
});

describe('Alt-click solo', () => {
  it('shows only the layer and its groups, then restores the previous visibility', () => {
    const { doc, bg, a, g, b, c, d } = setup();
    doc.updateLayer(a.id, { visible: false });
    const { changes, before } = soloChanges(doc, b.id);
    apply(doc, changes);
    const vis = () => [bg, a, g, b, c, d].map((l) => l.visible);
    expect(vis()).toEqual([false, false, true, true, false, false]);
    expect(isSoloState(doc, b.id, before)).toBe(true);
    apply(doc, restoreVisibility(doc, before));
    expect(vis()).toEqual([true, false, true, true, true, true]);
    expect(isSoloState(doc, b.id, before)).toBe(false);
  });

  it('soloing a group keeps its contents as they were', () => {
    const { doc, g, b, c, d } = setup();
    doc.updateLayer(c.id, { visible: false });
    const { changes, before } = soloChanges(doc, g.id);
    apply(doc, changes);
    expect([g.visible, b.visible, c.visible, d.visible]).toEqual([true, true, false, false]);
    expect(isSoloState(doc, g.id, before)).toBe(true);
    doc.updateLayer(d.id, { visible: true }); // a change since the solo
    expect(isSoloState(doc, g.id, before)).toBe(false);
  });
});
