/**
 * Zoom tool (Z).
 *
 * - Click: zoom in one preset step at the click point; Alt/Option-click zooms out
 *   (the options bar can make zoom-out the default; Alt then zooms in).
 * - Drag with Scrubby Zoom on (default): drag right to zoom in, left to zoom out,
 *   continuously, around the point where the drag started.
 * - Drag with Scrubby Zoom off: draw a rectangle; the view zooms to fit it.
 */
import type { Point } from '../../engine/viewport/viewport';
import type { CursorState, Tool, ToolContext, ToolPointerEvent, ViewRect } from '../types';

export interface ZoomToolOptions {
  /** What a plain click does. */
  mode: 'in' | 'out';
  scrubby: boolean;
}

/** Movement (CSS px) below which a press counts as a click. */
const CLICK_SLOP = 4;
/** Scrubby zoom: zoom doubles every this many CSS pixels of horizontal drag. */
const SCRUB_PIXELS_PER_DOUBLING = 150;

export class ZoomTool implements Tool {
  readonly id = 'zoom';
  readonly name = 'Zoom Tool';
  readonly key = 'Z';
  readonly options: ZoomToolOptions = { mode: 'in', scrubby: true };
  #start: Point | null = null;
  #last: Point | null = null;
  #moved = false;

  cursor({ altKey }: CursorState): string {
    return this.#zoomsIn(altKey) ? 'zoom-in' : 'zoom-out';
  }

  #zoomsIn(altKey: boolean): boolean {
    return (this.options.mode === 'in') !== altKey;
  }

  onPointerDown(e: ToolPointerEvent): void {
    this.#start = { x: e.x, y: e.y };
    this.#last = this.#start;
    this.#moved = false;
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!this.#start || !this.#last) return;
    const dpr = ctx.devicePixelRatio;
    if (!this.#moved && Math.hypot(e.x - this.#start.x, e.y - this.#start.y) < CLICK_SLOP * dpr) return;
    this.#moved = true;
    if (this.options.scrubby) {
      ctx.viewport.zoomBy(2 ** ((e.x - this.#last.x) / (SCRUB_PIXELS_PER_DOUBLING * dpr)), this.#start);
      ctx.viewChanged();
    } else {
      ctx.setOverlayRect(rectBetween(this.#start, e));
    }
    this.#last = { x: e.x, y: e.y };
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    const start = this.#start;
    this.#start = this.#last = null;
    if (!start) return;
    const point = { x: e.x, y: e.y };
    if (!this.#moved) {
      if (this.#zoomsIn(e.altKey)) ctx.viewport.zoomIn(point);
      else ctx.viewport.zoomOut(point);
      ctx.viewChanged();
    } else if (!this.options.scrubby) {
      ctx.setOverlayRect(null);
      zoomToViewRect(ctx, rectBetween(start, point));
    }
  }

  cancel(ctx: ToolContext): void {
    this.#start = this.#last = null;
    ctx.setOverlayRect(null);
  }
}

function rectBetween(a: Point, b: Point): ViewRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Zooms so the given view rectangle fills the view. */
export function zoomToViewRect(ctx: ToolContext, rect: ViewRect): void {
  const slop = CLICK_SLOP * ctx.devicePixelRatio;
  if (rect.w < slop || rect.h < slop) return;
  const v = ctx.viewport;
  const center = v.viewToDoc({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
  v.zoomTo(v.zoom * Math.min(v.viewWidth / rect.w, v.viewHeight / rect.h));
  v.centerX = center.x;
  v.centerY = center.y;
  ctx.viewChanged();
}
