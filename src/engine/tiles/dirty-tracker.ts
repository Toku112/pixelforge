/**
 * Tracks which parts of a document's composite need redrawing.
 *
 * Listens to document change events and accumulates dirty tiles in document tile
 * coordinates (256 × 256 px). The renderer calls `consume()` once per frame and
 * recomposites only those tiles. Property changes (opacity, visibility, blend
 * mode, moves) dirty the affected layer's bounds — for moves, both the old and the
 * new position; structural and canvas changes dirty everything.
 */
import type { DocumentChange, ImageDocument } from '../../core/document/document';
import {
  EMPTY_RECT,
  intersectRects,
  isEmptyRect,
  translateRect,
  unionRects,
  type Rect,
} from '../../core/document/geometry';
import type { LayerNode } from '../../core/document/layers';
import { tileCoordsFromKey, tileIndex, tileKey } from '../../core/document/tile';

export interface DirtySet {
  /** Everything must be redrawn (the tile list is then empty). */
  all: boolean;
  /** Dirty document tiles as [tx, ty], when `all` is false. */
  tiles: [number, number][];
}

/** Layer properties that do not change what the composite looks like. */
const NON_VISUAL_PROPS: ReadonlySet<string> = new Set(['name', 'expanded', 'locks']);
export class DirtyTracker {
  readonly #doc: ImageDocument;
  readonly #tiles = new Set<number>();
  #all = true;
  /** Last known document-space bounds of each layer, to dirty the old area after a move. */
  readonly #bounds = new Map<string, Rect>();
  readonly #unsubscribe: () => void;
  readonly #listeners = new Set<() => void>();

  constructor(doc: ImageDocument) {
    this.#doc = doc;
    this.#unsubscribe = doc.changes.on((change) => this.#onChange(change));
  }

  /** Called whenever something becomes dirty (e.g. to schedule a frame). */
  onDirty(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get isDirty(): boolean {
    return this.#all || this.#tiles.size > 0;
  }

  /** Returns and clears the dirty set. */
  consume(): DirtySet {
    const result: DirtySet = this.#all
      ? { all: true, tiles: [] }
      : { all: false, tiles: [...this.#tiles].map((k) => tileCoordsFromKey(k)) };
    this.#all = false;
    this.#tiles.clear();
    return result;
  }

  /** Marks a document-space rectangle dirty (clipped to the canvas). */
  markRect(r: Rect): void {
    const clipped = intersectRects(r, this.#doc.canvasRect);
    if (isEmptyRect(clipped) || this.#all) {
      if (!isEmptyRect(clipped)) this.#emit();
      return;
    }
    for (let ty = tileIndex(clipped.y); ty <= tileIndex(clipped.y + clipped.h - 1); ty++) {
      for (let tx = tileIndex(clipped.x); tx <= tileIndex(clipped.x + clipped.w - 1); tx++) {
        this.#tiles.add(tileKey(tx, ty));
      }
    }
    this.#emit();
  }

  markAll(): void {
    this.#all = true;
    this.#tiles.clear();
    this.#emit();
  }

  dispose(): void {
    this.#unsubscribe();
    this.#listeners.clear();
  }

  #onChange(change: DocumentChange): void {
    switch (change.kind) {
      case 'pixels': {
        this.#bounds.set(change.layerId, unionRects(this.#bounds.get(change.layerId) ?? EMPTY_RECT, change.rect));
        if (this.#isVisible(change.layerId)) this.markRect(change.rect);
        break;
      }
      case 'layer': {
        if (change.props.every((p) => NON_VISUAL_PROPS.has(p))) return;
        const layer = this.#doc.getLayer(change.layerId);
        if (!layer) return;
        const before = this.#bounds.get(layer.id) ?? EMPTY_RECT;
        const after = layerBounds(layer, this.#doc.canvasRect);
        this.#bounds.set(layer.id, after);
        if (layer.kind === 'pixel' && layer.isBackground) {
          this.markAll();
        } else {
          // Separately, not as a union: a move must not dirty the area in between.
          this.markRect(before);
          this.markRect(after);
        }
        break;
      }
      case 'structure':
      case 'canvas':
        this.#bounds.clear();
        this.markAll();
        break;
      case 'active-layer':
        break;
    }
  }

  /** A layer's pixels only show if it and all its ancestors are visible. */
  #isVisible(layerId: string): boolean {
    let node: LayerNode | null | undefined = this.#doc.getLayer(layerId);
    while (node && node !== this.#doc.root) {
      if (!node.visible) return false;
      node = node.parent;
    }
    return true;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Document-space bounds of a layer's allocated tiles (for groups, of all
 * descendants). A Background layer covers the whole canvas.
 */
export function layerBounds(layer: LayerNode, canvas: Rect): Rect {
  if (layer.kind === 'pixel') {
    if (layer.isBackground) return canvas;
    return translateRect(layer.buffer.tileBounds(), layer.offsetX, layer.offsetY);
  }
  return layer.children.reduce((acc, child) => unionRects(acc, layerBounds(child, canvas)), EMPTY_RECT);
}
