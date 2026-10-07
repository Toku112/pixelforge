/**
 * Marquee tools (M): Rectangular and Elliptical, plus Single Row and Single Column.
 *
 * Behaviour (own summary of the reference app):
 * - Drag to draw; edges snap to whole pixels. While dragging, Shift makes a square
 *   or circle and Alt/Option draws from the centre (when the key is pressed after
 *   the drag started — at the start these keys pick Add/Subtract), and holding
 *   Space moves the shape being drawn.
 * - Style: Normal; Fixed Ratio (width : height); Fixed Size (width × height px,
 *   placed where you press and moved with the pointer).
 * - Single Row/Column select a 1-pixel row or column across the whole canvas.
 */
import type { SelectionMode, SelectionShape } from '../../core/selection/mask-ops';
import type { Point } from '../../engine/viewport/viewport';
import type { ToolContext, ToolPointerEvent } from '../types';
import {
  CLICK_SLOP,
  SelectionTool,
  modeFor,
  type SelectionToolKind,
  type SelectionToolOptions,
} from './selection-tool';

export type MarqueeStyle = 'normal' | 'fixed-ratio' | 'fixed-size';

export interface MarqueeOptions extends SelectionToolOptions {
  style: MarqueeStyle;
  /** Ratio width or size in px, by style. */
  width: number;
  height: number;
}

interface Drag {
  anchor: Point;
  last: Point;
  startView: Point;
  mode: SelectionMode;
  /** Shift/Alt pressed at the start choose the mode; they constrain only once pressed again. */
  shiftFromStart: boolean;
  altFromStart: boolean;
  moved: boolean;
  rect: { x: number; y: number; w: number; h: number } | null;
}

/** The marquee rectangle for a drag from `a` to `b` (document coordinates, whole pixels). */
export function marqueeRect(
  a: Point,
  b: Point,
  options: Pick<MarqueeOptions, 'style' | 'width' | 'height'>,
  constrain: boolean,
  fromCenter: boolean,
): { x: number; y: number; w: number; h: number } {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (options.style === 'fixed-size') {
    const w = Math.max(1, Math.round(options.width));
    const h = Math.max(1, Math.round(options.height));
    const x = Math.round(fromCenter ? b.x - w / 2 : b.x);
    const y = Math.round(fromCenter ? b.y - h / 2 : b.y);
    return { x, y, w, h };
  }
  if (options.style === 'fixed-ratio' && options.width > 0 && options.height > 0) {
    const ratio = options.height / options.width;
    // Follow whichever side the pointer pulls further.
    if (Math.abs(dy) > Math.abs(dx) * ratio) dx = Math.sign(dx || 1) * (Math.abs(dy) / ratio);
    else dy = Math.sign(dy || 1) * Math.abs(dx) * ratio;
  } else if (constrain) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  const x0 = fromCenter ? a.x - Math.abs(dx) : Math.min(a.x, a.x + dx);
  const y0 = fromCenter ? a.y - Math.abs(dy) : Math.min(a.y, a.y + dy);
  const x1 = fromCenter ? a.x + Math.abs(dx) : Math.max(a.x, a.x + dx);
  const y1 = fromCenter ? a.y + Math.abs(dy) : Math.max(a.y, a.y + dy);
  const rx0 = Math.round(x0);
  const ry0 = Math.round(y0);
  return { x: rx0, y: ry0, w: Math.round(x1) - rx0, h: Math.round(y1) - ry0 };
}

export class MarqueeTool extends SelectionTool {
  readonly id: string;
  readonly name: string;
  readonly key = 'M';
  readonly kind: SelectionToolKind;
  override readonly options: MarqueeOptions;
  readonly #shape: 'rect' | 'ellipse';
  #drag: Drag | null = null;

  constructor(shape: 'rect' | 'ellipse') {
    super();
    this.#shape = shape;
    this.id = shape === 'rect' ? 'marquee-rect' : 'marquee-ellipse';
    this.name = shape === 'rect' ? 'Rectangular Marquee Tool' : 'Elliptical Marquee Tool';
    this.kind = shape === 'rect' ? 'rectangular-marquee' : 'elliptical-marquee';
    // Rectangles with whole-pixel edges need no anti-aliasing (the option is greyed out).
    this.options = { mode: 'new', feather: 0, antiAlias: true, style: 'normal', width: 1, height: 1 };
  }

  override setOptions(changes: Partial<MarqueeOptions>): void {
    Object.assign(this.options, changes);
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!ctx.document) return;
    if (this.options.style !== 'fixed-size' && this.startMove(e, ctx)) return;
    const p = this.docPoint(e, ctx);
    this.#drag = {
      anchor: p,
      last: p,
      startView: { x: e.x, y: e.y },
      mode: modeFor(e, this.options.mode),
      shiftFromStart: e.shiftKey,
      altFromStart: e.altKey,
      moved: this.options.style === 'fixed-size',
      rect: null,
    };
    if (this.options.style === 'fixed-size') this.#update(e, ctx);
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.continueMove(e, ctx)) return;
    const d = this.#drag;
    if (!d) return;
    if (!e.shiftKey) d.shiftFromStart = false;
    if (!e.altKey) d.altFromStart = false;
    if (!d.moved && Math.hypot(e.x - d.startView.x, e.y - d.startView.y) < CLICK_SLOP * ctx.devicePixelRatio) return;
    d.moved = true;
    this.#update(e, ctx);
  }

  #update(e: ToolPointerEvent, ctx: ToolContext): void {
    const d = this.#drag!;
    const p = this.docPoint(e, ctx);
    if (e.spaceKey) {
      // Space: move the whole shape with the pointer.
      d.anchor = { x: d.anchor.x + p.x - d.last.x, y: d.anchor.y + p.y - d.last.y };
    }
    d.last = p;
    const constrain = e.shiftKey && !d.shiftFromStart;
    const fromCenter = e.altKey && !d.altFromStart;
    d.rect = marqueeRect(d.anchor, p, this.options, constrain, fromCenter);
    ctx.setSelectionPreview({
      kind: 'shape',
      shape: this.#shapeOf(d.rect),
      closed: true,
      hideCurrent: d.mode === 'new',
    });
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.endMove(ctx)) return;
    const d = this.#drag;
    this.#drag = null;
    ctx.setSelectionPreview(null);
    if (!d) return;
    if (!d.moved || !d.rect || d.rect.w < 1 || d.rect.h < 1) {
      this.clicked(ctx, d.mode);
      return;
    }
    this.commit(ctx, this.#shapeOf(d.rect), d.mode);
  }

  #shapeOf(r: { x: number; y: number; w: number; h: number }): SelectionShape {
    return { kind: this.#shape, ...r };
  }

  override cancel(ctx: ToolContext): void {
    this.#drag = null;
    super.cancel(ctx);
  }
}

/** Single Row / Single Column Marquee: a 1-pixel line across the canvas. */
export class SingleLineMarqueeTool extends SelectionTool {
  readonly id: string;
  readonly name: string;
  readonly key = '';
  readonly kind: SelectionToolKind;
  readonly #axis: 'row' | 'column';
  #drag: { mode: SelectionMode; shape: SelectionShape } | null = null;

  constructor(axis: 'row' | 'column') {
    super({ antiAlias: false });
    this.#axis = axis;
    this.id = axis === 'row' ? 'marquee-row' : 'marquee-column';
    this.name = axis === 'row' ? 'Single Row Marquee Tool' : 'Single Column Marquee Tool';
    this.kind = axis === 'row' ? 'single-row-marquee' : 'single-column-marquee';
  }

  #line(e: ToolPointerEvent, ctx: ToolContext): SelectionShape {
    const doc = ctx.document!;
    const p = this.docPoint(e, ctx);
    return this.#axis === 'row'
      ? { kind: 'rect', x: 0, y: Math.floor(p.y), w: doc.width, h: 1 }
      : { kind: 'rect', x: Math.floor(p.x), y: 0, w: 1, h: doc.height };
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!ctx.document) return;
    const mode = modeFor(e, this.options.mode);
    this.#drag = { mode, shape: this.#line(e, ctx) };
    ctx.setSelectionPreview({ kind: 'shape', shape: this.#drag.shape, closed: true, hideCurrent: mode === 'new' });
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    const d = this.#drag;
    if (!d) return;
    d.shape = this.#line(e, ctx);
    ctx.setSelectionPreview({ kind: 'shape', shape: d.shape, closed: true, hideCurrent: d.mode === 'new' });
  }

  onPointerUp(_e: ToolPointerEvent, ctx: ToolContext): void {
    const d = this.#drag;
    this.#drag = null;
    ctx.setSelectionPreview(null);
    if (d) this.commit(ctx, d.shape, d.mode);
  }

  override cancel(ctx: ToolContext): void {
    this.#drag = null;
    super.cancel(ctx);
  }
}
