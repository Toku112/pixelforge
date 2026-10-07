/**
 * Lasso tools (L): freehand Lasso and Polygonal Lasso.
 *
 * Behaviour (own summary of the reference app):
 * - Lasso: drag to draw freehand; releasing closes the shape with a straight line.
 * - Polygonal Lasso: click to place corners; the next segment follows the pointer
 *   (Shift: in 45° steps). Close by clicking the first corner, double-clicking, or
 *   pressing Enter. Backspace/Delete removes the last corner; Escape cancels.
 */
import type { SelectionMode } from '../../core/selection/mask-ops';
import type { Point } from '../../engine/viewport/viewport';
import type { ToolContext, ToolPointerEvent } from '../types';
import { CLICK_SLOP, SelectionTool, modeFor, type SelectionToolKind } from './selection-tool';

/** Lasso points closer than this (document px) are not added. */
const MIN_STEP = 0.25;
/** A click within this distance (CSS px) of the first corner closes the polygon. */
const CLOSE_DISTANCE = 6;
/** Two clicks within this time (ms) and distance (CSS px) are a double-click. */
const DOUBLE_CLICK_MS = 400;

export class LassoTool extends SelectionTool {
  readonly id = 'lasso';
  readonly name = 'Lasso Tool';
  readonly key = 'L';
  readonly kind: SelectionToolKind = 'lasso';
  #drag: { points: number[]; mode: SelectionMode; startView: Point; moved: boolean } | null = null;

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!ctx.document || this.startMove(e, ctx)) return;
    const p = this.docPoint(e, ctx);
    this.#drag = {
      points: [p.x, p.y],
      mode: modeFor(e, this.options.mode),
      startView: { x: e.x, y: e.y },
      moved: false,
    };
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.continueMove(e, ctx)) return;
    const d = this.#drag;
    if (!d) return;
    if (Math.hypot(e.x - d.startView.x, e.y - d.startView.y) >= CLICK_SLOP * ctx.devicePixelRatio) d.moved = true;
    const p = this.docPoint(e, ctx);
    const n = d.points.length;
    if (Math.hypot(p.x - d.points[n - 2]!, p.y - d.points[n - 1]!) < MIN_STEP) return;
    d.points.push(p.x, p.y);
    ctx.setSelectionPreview({
      kind: 'shape',
      shape: { kind: 'polygon', points: d.points },
      closed: false,
      hideCurrent: d.mode === 'new',
    });
  }

  onPointerUp(_e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.endMove(ctx)) return;
    const d = this.#drag;
    this.#drag = null;
    ctx.setSelectionPreview(null);
    if (!d) return;
    if (!d.moved || d.points.length < 6) {
      this.clicked(ctx, d.mode);
      return;
    }
    this.commit(ctx, { kind: 'polygon', points: d.points }, d.mode);
  }

  override cancel(ctx: ToolContext): void {
    this.#drag = null;
    super.cancel(ctx);
  }
}

export class PolygonalLassoTool extends SelectionTool {
  readonly id = 'polygonal-lasso';
  readonly name = 'Polygonal Lasso Tool';
  readonly key = 'L';
  readonly kind: SelectionToolKind = 'polygonal-lasso';
  #poly: { points: number[]; mode: SelectionMode; hover: Point | null } | null = null;
  #lastClick: { time: number; x: number; y: number } | null = null;
  #moving = false;

  busy(): boolean {
    return this.#poly !== null;
  }

  /** The pointer position, constrained to 45° steps from the last corner with Shift. */
  #point(e: ToolPointerEvent, ctx: ToolContext): Point {
    const p = this.docPoint(e, ctx);
    const poly = this.#poly;
    if (!e.shiftKey || !poly) return p;
    const n = poly.points.length;
    const lx = poly.points[n - 2]!;
    const ly = poly.points[n - 1]!;
    const angle = Math.round(Math.atan2(p.y - ly, p.x - lx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(p.x - lx, p.y - ly);
    return { x: lx + Math.cos(angle) * len, y: ly + Math.sin(angle) * len };
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    const doc = ctx.document;
    if (!doc) return;
    const now = performance.now();
    const last = this.#lastClick;
    const dpr = ctx.devicePixelRatio;
    const double =
      !!last && now - last.time < DOUBLE_CLICK_MS && Math.hypot(e.x - last.x, e.y - last.y) < CLICK_SLOP * dpr;
    this.#lastClick = { time: now, x: e.x, y: e.y };
    const poly = this.#poly;
    if (!poly) {
      if (this.startMove(e, ctx)) {
        this.#moving = true;
        return;
      }
      const p = this.docPoint(e, ctx);
      this.#poly = { points: [p.x, p.y], mode: modeFor(e, this.options.mode), hover: null };
      this.#preview(ctx);
      return;
    }
    const first = ctx.viewport.docToView({ x: poly.points[0]!, y: poly.points[1]! });
    if (poly.points.length >= 6 && (double || Math.hypot(e.x - first.x, e.y - first.y) <= CLOSE_DISTANCE * dpr)) {
      this.#finish(ctx);
      return;
    }
    if (double) return; // the second click of a double-click on a fresh corner
    const p = this.#point(e, ctx);
    poly.points.push(p.x, p.y);
    this.#preview(ctx);
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.#moving) {
      this.continueMove(e, ctx);
      return;
    }
    this.onPointerHover(e, ctx);
  }

  onPointerHover(e: ToolPointerEvent, ctx: ToolContext): void {
    const poly = this.#poly;
    if (!poly) return;
    poly.hover = this.#point(e, ctx);
    this.#preview(ctx);
  }

  onPointerUp(_e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.#moving) {
      this.#moving = false;
      this.endMove(ctx);
    }
  }

  onKeyDown(key: string, ctx: ToolContext): boolean {
    const poly = this.#poly;
    if (!poly) return false;
    if (key === 'Enter') {
      if (poly.points.length >= 6) this.#finish(ctx);
      else this.cancel(ctx);
      return true;
    }
    if (key === 'Escape') {
      this.cancel(ctx);
      return true;
    }
    if (key === 'Backspace' || key === 'Delete') {
      poly.points.splice(-2, 2);
      if (poly.points.length === 0) this.cancel(ctx);
      else this.#preview(ctx);
      return true;
    }
    return false;
  }

  #preview(ctx: ToolContext): void {
    const poly = this.#poly!;
    const points = poly.hover ? [...poly.points, poly.hover.x, poly.hover.y] : poly.points;
    ctx.setSelectionPreview(
      points.length >= 4
        ? { kind: 'shape', shape: { kind: 'polygon', points }, closed: false, hideCurrent: poly.mode === 'new' }
        : null,
    );
  }

  #finish(ctx: ToolContext): void {
    const poly = this.#poly!;
    this.#poly = null;
    ctx.setSelectionPreview(null);
    this.commit(ctx, { kind: 'polygon', points: poly.points }, poly.mode);
  }

  override cancel(ctx: ToolContext): void {
    this.#poly = null;
    this.#moving = false;
    this.cancelMove();
    super.cancel(ctx);
  }
}
