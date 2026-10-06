/**
 * Undo data for pixel commands: only the tiles that changed (CLAUDE.md §3.2).
 *
 * Both the "before" and "after" versions of each tile are kept as frozen
 * (immutable) tiles, so undo and redo are just tile swaps — no recomputation and
 * no whole-layer copies. Layers are looked up by id at undo/redo time, so the
 * diff stays valid if the history restores the layer tree from a snapshot.
 */
import type { ImageDocument } from '../document/document';
import { tileCoordsFromKey, tileKey, type Tile } from '../document/tile';

export class LayerTileDiff {
  readonly layerId: string;
  readonly #before = new Map<number, Tile | undefined>();
  readonly #after = new Map<number, Tile | undefined>();

  constructor(layerId: string) {
    this.layerId = layerId;
  }

  get tileCount(): number {
    return this.#before.size;
  }

  /** Records the current version of a tile before it is modified (first call per tile wins). */
  captureBefore(doc: ImageDocument, tx: number, ty: number): void {
    const key = tileKey(tx, ty);
    if (this.#before.has(key)) return;
    this.#before.set(key, doc.requirePixelLayer(this.layerId).buffer.captureTile(tx, ty));
  }

  /** Records the modified versions of all captured tiles. Call once the change is complete. */
  captureAfter(doc: ImageDocument): void {
    const buffer = doc.requirePixelLayer(this.layerId).buffer;
    for (const key of this.#before.keys()) {
      const [tx, ty] = tileCoordsFromKey(key);
      this.#after.set(key, buffer.captureTile(tx, ty));
    }
  }

  undo(doc: ImageDocument): void {
    this.#apply(doc, this.#before);
  }

  redo(doc: ImageDocument): void {
    this.#apply(doc, this.#after);
  }

  /** Memory held by this diff (tiles shared with the live document are counted too). */
  get bytes(): number {
    let total = 0;
    for (const map of [this.#before, this.#after]) {
      for (const tile of map.values()) total += tile?.data.byteLength ?? 0;
    }
    return total;
  }

  #apply(doc: ImageDocument, tiles: Map<number, Tile | undefined>): void {
    const buffer = doc.requirePixelLayer(this.layerId).buffer;
    for (const [key, tile] of tiles) {
      const [tx, ty] = tileCoordsFromKey(key);
      buffer.setTile(tx, ty, tile);
    }
  }
}
