/**
 * Layers panel model (no React, no DOM): the rows the panel shows, and the
 * selection, drag-and-drop and visibility rules behind its clicks.
 *
 * Behaviour (own summary of the reference app's Layers panel):
 * - Rows list layers top → bottom; a collapsed group hides its contents.
 * - Click selects one layer; Ctrl/Cmd-click adds or removes a layer; Shift-click
 *   selects the range from the active layer in the order the rows are shown.
 * - Dragging drops the selected layers between rows, or into a group when
 *   released over the middle of a group row. Nothing can go below the Background.
 * - Alt/Option-click on an eye shows only that layer; doing it again on the same
 *   layer brings back the visibility every layer had before.
 */
import type { ImageDocument } from '../../../core/document/document';
import { effectiveLocks, type GroupLayer, type LayerLocks, type LayerNode } from '../../../core/document/layers';

export type LockState = 'none' | 'partial' | 'all';

export interface LayerRow {
  layer: LayerNode;
  depth: number;
  /** False when a containing group is hidden (the row's eye is shown dimmed). */
  shown: boolean;
  selected: boolean;
  active: boolean;
  /** The layer's own locks, or (when it has none) those inherited from a locked group. */
  lock: LockState;
  lockInherited: boolean;
}

function lockState(locks: LayerLocks): LockState {
  if (locks.all) return 'all';
  return locks.transparency || locks.pixels || locks.position ? 'partial' : 'none';
}

export function layerRows(doc: ImageDocument): LayerRow[] {
  const rows: LayerRow[] = [];
  const selected = new Set(doc.selectedLayerIds);
  const walk = (children: readonly LayerNode[], depth: number, shown: boolean) => {
    for (let i = children.length - 1; i >= 0; i--) {
      const layer = children[i]!;
      const own = lockState(layer.locks);
      const inherited = own === 'none' ? lockState(effectiveLocks(layer)) : 'none';
      rows.push({
        layer,
        depth,
        shown,
        selected: selected.has(layer.id),
        active: doc.activeLayerId === layer.id,
        lock: own !== 'none' ? own : inherited,
        lockInherited: inherited !== 'none',
      });
      if (layer.kind === 'group' && layer.expanded) walk(layer.children, depth + 1, shown && layer.visible);
    }
  };
  walk(doc.root.children, 0, true);
  return rows;
}

/** Ids of the rows from `fromId` to `toId` (inclusive, either direction). */
export function rowRange(rows: readonly LayerRow[], fromId: string, toId: string): string[] {
  const a = rows.findIndex((r) => r.layer.id === fromId);
  const b = rows.findIndex((r) => r.layer.id === toId);
  if (b < 0) return [];
  if (a < 0) return [toId];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return rows.slice(lo, hi + 1).map((r) => r.layer.id);
}

/** Selection after Ctrl/Cmd-clicking `id`: added (and made active), or removed. */
export function toggleSelection(
  selected: readonly string[],
  active: string | null,
  id: string,
): { ids: string[]; active: string | null } {
  if (!selected.includes(id)) return { ids: [...selected, id], active: id };
  const ids = selected.filter((s) => s !== id);
  return { ids, active: active !== id && active !== null ? active : (ids.at(-1) ?? null) };
}

export type DropZone = 'above' | 'below' | 'inside';

/**
 * Where the dragged layers land for a drop on `targetId` (`moveLayers` parameters:
 * the parent and the index among its children without the moving layers), or
 * null when the drop is not allowed.
 */
export function dropPlacement(
  doc: ImageDocument,
  moving: readonly string[],
  targetId: string,
  zone: DropZone,
): { parentId: string; index: number } | null {
  const target = doc.getLayer(targetId);
  if (!target || moving.length === 0) return null;
  if (moving.some((id) => doc.isWithin(targetId, id))) return null; // onto itself or into its own contents
  const intoGroup = (group: GroupLayer) => ({
    parentId: group.id,
    index: group.children.filter((c) => !moving.includes(c.id)).length,
  });
  if (target.kind === 'group' && (zone === 'inside' || (zone === 'below' && target.expanded))) {
    return intoGroup(target);
  }
  if (zone === 'inside') return null;
  const parent = target.parent;
  if (!parent) return null;
  const others = parent.children.filter((c) => !moving.includes(c.id));
  const at = others.indexOf(target);
  const index = zone === 'above' ? at + 1 : at;
  const bottom = others[0];
  if (index === 0 && parent === doc.root && bottom?.kind === 'pixel' && bottom.isBackground) return null;
  return { parentId: parent.id, index };
}

/** Visibility changes for one `setLayerProps` step. */
export type VisibilityChange = { layerId: string; props: { visible: boolean } };

/**
 * Alt/Option-click on an eye: show only `layerId` (with the groups containing it
 * and its own contents), hiding every other layer. Returns the changes and the
 * visibility to restore on a second Alt-click.
 */
export function soloChanges(
  doc: ImageDocument,
  layerId: string,
): { changes: VisibilityChange[]; before: Map<string, boolean> } {
  const before = new Map<string, boolean>();
  const changes: VisibilityChange[] = [];
  for (const layer of doc.layers()) {
    before.set(layer.id, layer.visible);
    const keep = doc.isWithin(layerId, layer.id) || doc.isWithin(layer.id, layerId);
    const visible = keep && (layer.id !== layerId && doc.isWithin(layer.id, layerId) ? layer.visible : true);
    if (visible !== layer.visible) changes.push({ layerId: layer.id, props: { visible } });
  }
  return { changes, before };
}

/** Changes that bring back `before` (layers since deleted are skipped). */
export function restoreVisibility(doc: ImageDocument, before: ReadonlyMap<string, boolean>): VisibilityChange[] {
  const changes: VisibilityChange[] = [];
  for (const [id, visible] of before) {
    const layer = doc.getLayer(id);
    if (layer && layer.visible !== visible) changes.push({ layerId: id, props: { visible } });
  }
  return changes;
}

/** True when every layer's visibility is still what a solo of `layerId` produced. */
export function isSoloState(doc: ImageDocument, layerId: string, before: ReadonlyMap<string, boolean>): boolean {
  if (!doc.getLayer(layerId)) return false;
  for (const layer of doc.layers()) {
    if (!before.has(layer.id)) return false;
    const keep = doc.isWithin(layerId, layer.id) || doc.isWithin(layer.id, layerId);
    const expected = keep
      ? layer.id !== layerId && doc.isWithin(layer.id, layerId)
        ? before.get(layer.id)
        : true
      : false;
    if (layer.visible !== expected) return false;
  }
  return true;
}
