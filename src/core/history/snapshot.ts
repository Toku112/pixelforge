/**
 * Whole-document snapshots for the History panel (the "Open" state and user
 * snapshots). Capturing is cheap: layer buffers are cloned by sharing frozen
 * tiles, so a snapshot only costs memory for tiles that later change.
 */
import type { CanvasProps, ImageDocument } from '../document/document';
import { GroupLayer, PixelLayer, type LayerNode } from '../document/layers';

export interface DocumentState {
  readonly canvas: CanvasProps;
  /** Detached copies of the top-level layers (bottom → top). */
  readonly layers: readonly LayerNode[];
  readonly activeLayerId: string | null;
}

function cloneLayer(layer: LayerNode): LayerNode {
  let copy: LayerNode;
  if (layer.kind === 'pixel') {
    const pixel = new PixelLayer(layer.id, layer.name, layer.buffer.clone(), layer.isBackground);
    pixel.offsetX = layer.offsetX;
    pixel.offsetY = layer.offsetY;
    copy = pixel;
  } else {
    const group = new GroupLayer(layer.id, layer.name);
    group.expanded = layer.expanded;
    for (const child of layer.children) {
      const childCopy = cloneLayer(child);
      childCopy.parent = group;
      group.children.push(childCopy);
    }
    copy = group;
  }
  copy.visible = layer.visible;
  copy.opacity = layer.opacity;
  copy.fillOpacity = layer.fillOpacity;
  copy.blendMode = layer.blendMode;
  copy.locks = layer.locks;
  return copy;
}

function detach(layer: LayerNode): LayerNode {
  layer.parent = null;
  return layer;
}

export function captureDocumentState(doc: ImageDocument): DocumentState {
  return {
    canvas: doc.canvasProps(),
    layers: doc.root.children.map((l) => detach(cloneLayer(l))),
    activeLayerId: doc.activeLayerId,
  };
}

/** Replaces the document's canvas properties and layers with the snapshot's (which stays reusable). */
export function restoreDocumentState(doc: ImageDocument, state: DocumentState): void {
  for (const layer of [...doc.root.children].reverse()) doc.removeLayer(layer.id);
  doc.setCanvasProps(state.canvas);
  for (const layer of state.layers) doc.insertLayer(detach(cloneLayer(layer)));
  doc.setActiveLayer(state.activeLayerId !== null && doc.getLayer(state.activeLayerId) ? state.activeLayerId : null);
}
