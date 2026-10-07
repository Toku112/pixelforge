/**
 * Selections (CLAUDE.md §3.1): an 8-bit mask over the document — 0 not selected,
 * 255 fully selected, values between for feathered and anti-aliased edges.
 *
 * The mask is stored sparsely as 256 × 256 tiles plus a `fill` value for every
 * pixel outside them (0, or 255 after Select All / Inverse), on a grid that can be
 * shifted by an integer offset (so moving a selection outline is free). Only the
 * part inside the canvas counts: outside it nothing is ever selected.
 *
 * A Selection never changes after it is made — commands replace the document's
 * selection with a new one — so history steps can share it safely.
 */
import { EMPTY_RECT, intersectRects, translateRect, unionRects, type Rect } from '../document/geometry';
import { TILE_SIZE, tileIndex, tileKey } from '../document/tile';

export interface MaskTile {
  tx: number;
  ty: number;
  /** TILE_SIZE × TILE_SIZE values, row by row. */
  data: Uint8Array;
}

/** Plain description of a selection mask (what workers receive and return). */
export interface MaskData {
  tiles: MaskTile[];
  /** Value outside the listed tiles: 0 or 255. */
  fill: number;
  /** The tile grid's position in document coordinates. */
  offsetX: number;
  offsetY: number;
}

export class Selection {
  readonly data: Readonly<MaskData>;
  readonly #tiles = new Map<number, Uint8Array>();

  constructor(data: MaskData) {
    if (data.fill !== 0 && data.fill !== 255) throw new Error('Selection: fill must be 0 or 255');
    this.data = Object.freeze({ ...data, tiles: Object.freeze([...data.tiles]) as MaskTile[] });
    for (const t of data.tiles) {
      if (t.data.length !== TILE_SIZE * TILE_SIZE) throw new Error('Selection: mask tiles must be whole tiles');
      this.#tiles.set(tileKey(t.tx, t.ty), t.data);
    }
  }

  /** Everything inside the canvas (Select All). */
  static all(): Selection {
    return new Selection({ tiles: [], fill: 255, offsetX: 0, offsetY: 0 });
  }

  /** Mask value (0–255) at a document pixel; 0 outside the canvas. */
  value(x: number, y: number, canvas: Rect): number {
    if (x < canvas.x || y < canvas.y || x >= canvas.x + canvas.w || y >= canvas.y + canvas.h) return 0;
    const lx = x - this.data.offsetX;
    const ly = y - this.data.offsetY;
    const tx = tileIndex(lx);
    const ty = tileIndex(ly);
    const tile = this.#tiles.get(tileKey(tx, ty));
    return tile ? tile[(ly - ty * TILE_SIZE) * TILE_SIZE + (lx - tx * TILE_SIZE)]! : this.data.fill;
  }

  /** Document area that may be selected (tile-aligned, within the canvas). */
  bounds(canvas: Rect): Rect {
    if (this.data.fill === 255) return canvas;
    let b = EMPTY_RECT;
    for (const t of this.data.tiles) {
      b = unionRects(b, { x: t.tx * TILE_SIZE, y: t.ty * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE });
    }
    return intersectRects(translateRect(b, this.data.offsetX, this.data.offsetY), canvas);
  }

  /** The same mask moved by whole pixels (dragging a selection outline). */
  moved(dx: number, dy: number): Selection {
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) throw new Error('Selections move by whole pixels');
    return new Selection({ ...this.data, offsetX: this.data.offsetX + dx, offsetY: this.data.offsetY + dy });
  }
}
