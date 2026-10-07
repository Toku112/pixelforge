/**
 * Crop tool (C).
 *
 * Behaviour (own summary of the reference app, classic mode):
 * - When the tool is chosen, a crop box covers the whole canvas. Dragging draws a
 *   new box; once a box is drawn, dragging inside it moves it, and dragging its
 *   edges or corner handles resizes it. The box may reach past the canvas: the
 *   canvas then grows (the Background gets the background colour there).
 * - Shift keeps the proportions (a square when drawing freely), Alt/Option sizes
 *   from the centre. A ratio (width : height) in the options bar constrains the box.
 * - Enter (or the ✓ button) crops; Escape (or ⊘) returns the box to the whole canvas.
 * - The area outside the box is shaded; a rule-of-thirds grid shows while dragging.
 * - Delete Cropped Pixels (on by default): when off, pixels outside the box are kept
 *   (hidden beyond the canvas) and the Background becomes a normal layer.
 * Straightening, rotating the box and the other overlays come with the full Crop tool
 * (PLAN Part B, Crop & slice).
 */
import type { Rect } from '../../core/document/geometry';
import type { Point } from '../../engine/viewport/viewport';
import type { CursorState, Tool, ToolContext, ToolPointerEvent } from '../types';

export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface CropOptions {
  /** Ratio width : height; 0 for either means free. */
  ratioW: number;
  ratioH: number;
  deleteCropped: boolean;
}

/** Handle grab distance, CSS pixels. */
const GRAB = 8;
/** A press that moves less than this (CSS pixels) does not draw a new box. */
const CLICK_SLOP = 3;

const CURSORS: Record<CropHandle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

/** The handle (or edge) of `box` at document point `p`, within `tol` document pixels; 'inside' or null. */
export function cropHitTest(box: Rect, p: Point, tol: number): CropHandle | 'inside' | null {
  const x1 = box.x + box.w;
  const y1 = box.y + box.h;
  const nearL = Math.abs(p.x - box.x) <= tol;
  const nearR = Math.abs(p.x - x1) <= tol;
  const nearT = Math.abs(p.y - box.y) <= tol;
  const nearB = Math.abs(p.y - y1) <= tol;
  const withinX = p.x >= box.x - tol && p.x <= x1 + tol;
  const withinY = p.y >= box.y - tol && p.y <= y1 + tol;
  if (nearT && nearL) return 'nw';
  if (nearT && nearR) return 'ne';
  if (nearB && nearL) return 'sw';
  if (nearB && nearR) return 'se';
  if (nearT && withinX) return 'n';
  if (nearB && withinX) return 's';
  if (nearL && withinY) return 'w';
  if (nearR && withinY) return 'e';
  if (p.x > box.x && p.x < x1 && p.y > box.y && p.y < y1) return 'inside';
  return null;
}

/** h / w of the ratio option, or null when free. */
function ratioOf(options: Pick<CropOptions, 'ratioW' | 'ratioH'>): number | null {
  return options.ratioW > 0 && options.ratioH > 0 ? options.ratioH / options.ratioW : null;
}

/** A new box dragged from `a` to `b` (whole pixels). `ratio`: h / w to keep, or null. */
export function drawCropRect(a: Point, b: Point, ratio: number | null, fromCenter: boolean): Rect {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (ratio !== null) {
    // Follow whichever side the pointer pulls further.
    if (Math.abs(dy) > Math.abs(dx) * ratio) dx = Math.sign(dx || 1) * (Math.abs(dy) / ratio);
    else dy = Math.sign(dy || 1) * Math.abs(dx) * ratio;
  }
  const x0 = fromCenter ? a.x - Math.abs(dx) : Math.min(a.x, a.x + dx);
  const y0 = fromCenter ? a.y - Math.abs(dy) : Math.min(a.y, a.y + dy);
  const x1 = fromCenter ? a.x + Math.abs(dx) : Math.max(a.x, a.x + dx);
  const y1 = fromCenter ? a.y + Math.abs(dy) : Math.max(a.y, a.y + dy);
  const rx = Math.round(x0);
  const ry = Math.round(y0);
  return { x: rx, y: ry, w: Math.max(1, Math.round(x1) - rx), h: Math.max(1, Math.round(y1) - ry) };
}

/**
 * `from` with a handle dragged by (dx, dy) (whole pixels). `ratio` (h / w) is kept
 * when given; `fromCenter` moves the opposite side by the same amount.
 */
export function resizeCropRect(
  from: Rect,
  handle: CropHandle,
  dx: number,
  dy: number,
  ratio: number | null,
  fromCenter: boolean,
): Rect {
  const k = fromCenter ? 2 : 1;
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.startsWith('n');
  const south = handle.startsWith('s');
  let w = from.w + (east ? dx * k : west ? -dx * k : 0);
  let h = from.h + (south ? dy * k : north ? -dy * k : 0);
  w = Math.max(1, w);
  h = Math.max(1, h);
  if (ratio !== null) {
    const horizontal = east || west;
    const vertical = north || south;
    if (horizontal && !vertical) h = w * ratio;
    else if (vertical && !horizontal) w = h / ratio;
    else if (h > w * ratio) w = h / ratio;
    else h = w * ratio;
  }
  // Anchor: the opposite side (or the centre), which stays where it was.
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let x: number;
  let y: number;
  if (fromCenter) {
    x = cx - w / 2;
    y = cy - h / 2;
  } else {
    // An edge handle under a ratio grows the other dimension about its middle.
    x = west ? from.x + from.w - w : east ? from.x : cx - w / 2;
    y = north ? from.y + from.h - h : south ? from.y : cy - h / 2;
  }
  const rx = Math.round(x);
  const ry = Math.round(y);
  return { x: rx, y: ry, w: Math.max(1, Math.round(x + w) - rx), h: Math.max(1, Math.round(y + h) - ry) };
}

/** The largest box of ratio `ratio` (h / w) centred in `r`. */
export function fitRatio(r: Rect, ratio: number): Rect {
  let w = r.w;
  let h = w * ratio;
  if (h > r.h) {
    h = r.h;
    w = h / ratio;
  }
  const x = Math.round(r.x + (r.w - w) / 2);
  const y = Math.round(r.y + (r.h - h) / 2);
  return { x, y, w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

type Drag =
  | { kind: 'draw'; anchor: Point; startView: Point; before: Rect | null; moved: boolean }
  | { kind: 'move'; start: Point; from: Rect }
  | { kind: 'resize'; handle: CropHandle; start: Point; from: Rect };

export class CropTool implements Tool {
  readonly id = 'crop';
  readonly name = 'Crop Tool';
  readonly key = 'C';
  options: CropOptions = { ratioW: 0, ratioH: 0, deleteCropped: true };
  /** The drawn box (document pixels); null: the untouched box over the whole canvas. */
  #box: Rect | null = null;
  #drag: Drag | null = null;
  #hover: CropHandle | 'inside' | null = null;
  #active = false;

  /** The crop box (document pixels), or null when it still covers the whole canvas. */
  get box(): Rect | null {
    return this.#box;
  }

  setOptions(changes: Partial<CropOptions>, ctx?: ToolContext): void {
    this.options = { ...this.options, ...changes };
    const ratio = ratioOf(this.options);
    const doc = ctx?.document;
    if (ratio === null || !doc || !('ratioW' in changes || 'ratioH' in changes)) return;
    // A new ratio reshapes the box at once.
    this.#box = fitRatio(this.#box ?? doc.canvasRect, ratio);
    this.#show(ctx);
  }

  cursor(state: CursorState): string {
    const at = this.#drag
      ? this.#drag.kind === 'resize'
        ? this.#drag.handle
        : this.#drag.kind === 'move'
          ? 'inside'
          : null
      : this.#hover;
    if (at === 'inside') return state.dragging || this.#box ? 'move' : 'crosshair';
    return at ? CURSORS[at] : 'crosshair';
  }

  activate(ctx: ToolContext): void {
    this.#active = true;
    this.#box = null;
    this.#drag = null;
    this.#show(ctx);
  }

  deactivate(ctx: ToolContext): void {
    this.#active = false;
    this.#drag = null;
    this.#box = null;
    ctx.setCropBox(null);
  }

  /** Abandons a drag in progress (the box returns to where it was). */
  cancel(ctx: ToolContext): void {
    const drag = this.#drag;
    if (!drag) return;
    this.#drag = null;
    this.#box = drag.kind === 'draw' ? drag.before : drag.from;
    this.#show(ctx);
  }

  busy(): boolean {
    return this.#drag !== null;
  }

  onPointerHover(e: ToolPointerEvent, ctx: ToolContext): void {
    const doc = ctx.document;
    if (!doc) return;
    if (!this.#active) this.activate(ctx);
    const box = this.#box ?? doc.canvasRect;
    this.#hover = cropHitTest(box, ctx.viewport.viewToDoc(e), this.#tolerance(ctx));
  }

  onPointerLeave(): void {
    this.#hover = null;
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    const doc = ctx.document;
    if (!doc) return;
    if (!this.#active) this.activate(ctx);
    const p = ctx.viewport.viewToDoc(e);
    const box = this.#box ?? doc.canvasRect;
    const hit = cropHitTest(box, p, this.#tolerance(ctx));
    if (hit && hit !== 'inside') this.#drag = { kind: 'resize', handle: hit, start: p, from: box };
    else if (hit === 'inside' && this.#box) this.#drag = { kind: 'move', start: p, from: box };
    else this.#drag = { kind: 'draw', anchor: p, startView: { x: e.x, y: e.y }, before: this.#box, moved: false };
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    const drag = this.#drag;
    if (!drag) return;
    const p = ctx.viewport.viewToDoc(e);
    const ratio = ratioOf(this.options);
    if (drag.kind === 'draw') {
      if (!drag.moved) {
        const slop = CLICK_SLOP * ctx.devicePixelRatio;
        if (Math.hypot(e.x - drag.startView.x, e.y - drag.startView.y) < slop) return;
        drag.moved = true;
      }
      this.#box = drawCropRect(drag.anchor, p, ratio ?? (e.shiftKey ? 1 : null), e.altKey);
    } else if (drag.kind === 'move') {
      const dx = Math.round(p.x - drag.start.x);
      const dy = Math.round(p.y - drag.start.y);
      this.#box = { ...drag.from, x: drag.from.x + dx, y: drag.from.y + dy };
    } else {
      const corner = drag.handle.length === 2;
      const keep = ratio ?? (e.shiftKey && corner ? drag.from.h / drag.from.w : null);
      this.#box = resizeCropRect(
        drag.from,
        drag.handle,
        Math.round(p.x - drag.start.x),
        Math.round(p.y - drag.start.y),
        keep,
        e.altKey,
      );
    }
    this.#show(ctx);
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!this.#drag) return;
    this.onPointerMove(e, ctx);
    this.#drag = null;
    this.#show(ctx);
  }

  onKeyDown(key: string, ctx: ToolContext): boolean {
    if (key === 'Enter') {
      if (this.#drag) return true;
      this.commit(ctx);
      return true;
    }
    if (key === 'Escape') {
      if (this.#drag) {
        this.cancel(ctx);
        return true;
      }
      if (!this.#box) return false;
      this.reset(ctx);
      return true;
    }
    return false;
  }

  /** Crops to the box (nothing happens while the box still covers exactly the canvas). */
  commit(ctx: ToolContext): void {
    const doc = ctx.document;
    const box = this.#box;
    this.#box = null;
    this.#show(ctx);
    if (!doc || !box) return;
    if (box.x === 0 && box.y === 0 && box.w === doc.width && box.h === doc.height) return;
    ctx.execute({
      name: 'crop',
      params: { x: box.x, y: box.y, w: box.w, h: box.h, deleteCropped: this.options.deleteCropped },
    });
  }

  /** Returns the box to the whole canvas. */
  reset(ctx: ToolContext): void {
    this.#drag = null;
    this.#box = null;
    this.#show(ctx);
  }

  #tolerance(ctx: ToolContext): number {
    return (GRAB * ctx.devicePixelRatio) / ctx.viewport.zoom;
  }

  #show(ctx: ToolContext): void {
    if (!this.#active || !ctx.document) {
      ctx.setCropBox(null);
      return;
    }
    const drag = this.#drag;
    ctx.setCropBox({ rect: this.#box, thirds: drag !== null && (drag.kind !== 'draw' || drag.moved) });
  }
}
