/**
 * Whole-document snapshots for the History panel (the "Open" state and user
 * snapshots). Capturing is cheap: layer buffers are cloned by sharing frozen
 * tiles, so a snapshot only costs memory for tiles that later change.
 */
import type { Selection } from '../selection/selection';
import type { CanvasProps, ImageDocument } from '../document/document';
import { GroupLayer, PixelLayer, type LayerNode } from '../document/layers';
import type { Tile } from '../document/tile';

export interface DocumentState {
  readonly canvas: CanvasProps;
  /** Detached copies of the top-level layers (bottom → top). */
  readonly layers: readonly LayerNode[];
  readonly activeLayerId: string | null;
  readonly selectedLayerIds: readonly string[];
  /** Selections never change, so the snapshot keeps the same objects. */
  readonly selection: Selection | null;
  readonly reselect: Selection | null;
}

/**
 * A detached copy of a layer (and its children) sharing frozen tiles. Ids are kept,
 * or replaced via `idFor` (for duplicates).
 */
export function cloneLayer(layer: LayerNode, idFor: (oldId: string) => string = (id) => id): LayerNode {
  let copy: LayerNode;
  if (layer.kind === 'pixel') {
    const pixel = new PixelLayer(idFor(layer.id), layer.name, layer.buffer.clone(), layer.isBackground);
    pixel.offsetX = layer.offsetX;
    pixel.offsetY = layer.offsetY;
    copy = pixel;
  } else {
    const group = new GroupLayer(idFor(layer.id), layer.name);
    group.expanded = layer.expanded;
    for (const child of layer.children) {
      const childCopy = cloneLayer(child, idFor);
      childCopy.parent = group;
      group.children.push(childCopy);
    }
    copy = group;
  }
  copyLayerProps(layer, copy);
  return copy;
}

/** Copies the properties every layer has (visibility, opacity, blending, locks). */
export function copyLayerProps(from: LayerNode, to: LayerNode): void {
  to.visible = from.visible;
  to.opacity = from.opacity;
  to.fillOpacity = from.fillOpacity;
  to.blendMode = from.blendMode;
  to.locks = from.locks;
}

/** Every tile held by a layer tree (for residency management). */
export function* layerTreeTiles(layer: LayerNode): IterableIterator<Tile> {
  if (layer.kind === 'pixel') for (const [, , tile] of layer.buffer.tiles()) yield tile;
  else for (const child of layer.children) yield* layerTreeTiles(child);
}

export function detach(layer: LayerNode): LayerNode {
  layer.parent = null;
  return layer;
}

export function captureDocumentState(doc: ImageDocument): DocumentState {
  return {
    canvas: doc.canvasProps(),
    layers: doc.root.children.map((l) => detach(cloneLayer(l))),
    activeLayerId: doc.activeLayerId,
    selectedLayerIds: [...doc.selectedLayerIds],
    selection: doc.selection,
    reselect: doc.reselectable,
  };
}

/** Replaces the document's canvas properties and layers with the snapshot's (which stays reusable). */
export function restoreDocumentState(doc: ImageDocument, state: DocumentState): void {
  for (const layer of [...doc.root.children].reverse()) doc.removeLayer(layer.id);
  doc.setCanvasProps(state.canvas);
  for (const layer of state.layers) doc.insertLayer(detach(cloneLayer(layer)));
  const selected = state.selectedLayerIds.filter((id) => doc.getLayer(id));
  const active =
    state.activeLayerId !== null && selected.includes(state.activeLayerId)
      ? state.activeLayerId
      : (selected.at(-1) ?? null);
  doc.selectLayers(selected, active);
  doc.setSelection(state.selection, state.reselect);
}

/** Every tile a snapshot holds (for residency management). */
export function* stateTiles(state: DocumentState): IterableIterator<Tile> {
  for (const layer of state.layers) yield* layerTreeTiles(layer);
}
