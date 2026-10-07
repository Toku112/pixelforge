/**
 * Shared behaviour of the selection tools (marquees and lassos).
 *
 * Behaviour (own summary of the reference app):
 * - How a new shape combines with the current selection comes from the options bar
 *   (New, Add, Subtract, Intersect), unless a modifier is held when the press
 *   starts: Shift adds, Alt/Option subtracts, Shift+Alt/Option intersects.
 * - With New and no modifiers, pressing inside the current selection and dragging
 *   moves the selection outline (not the pixels).
 * - A click that does not draw anything deselects (with New).
 * - Feather softens each new shape; Anti-alias smooths curved and slanted edges.
 */
import type { SelectionMode, SelectionShape } from '../../core/selection/mask-ops';
import type { Point } from '../../engine/viewport/viewport';
import type { CursorState, Tool, ToolContext, ToolPointerEvent } from '../types';

export interface SelectionToolOptions {
  mode: SelectionMode;
  /** Feather radius, px (0–1000). */
  feather: number;
  antiAlias: boolean;
}

/** History/descriptor names of the selection tools (see core selection commands). */
export type SelectionToolKind =
  | 'rectangular-marquee'
  | 'elliptical-marquee'
  | 'single-row-marquee'
  | 'single-column-marquee'
  | 'lasso'
  | 'polygonal-lasso';

/** Movement (CSS px) below which a press counts as a click. */
export const CLICK_SLOP = 3;

/** The combination mode for a press: modifiers win over the options bar. */
export function modeFor(e: ToolPointerEvent, fallback: SelectionMode): SelectionMode {
  if (e.shiftKey && e.altKey) return 'intersect';
  if (e.shiftKey) return 'add';
  if (e.altKey) return 'subtract';
  return fallback;
}

export abstract class SelectionTool implements Tool {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly key: string;
  abstract readonly kind: SelectionToolKind;
  readonly options: SelectionToolOptions;
  #move: { start: Point; startView: Point; moved: boolean; dx: number; dy: number } | null = null;

  constructor(options: Partial<SelectionToolOptions> = {}) {
    this.options = { mode: 'new', feather: 0, antiAlias: true, ...options };
  }

  setOptions(changes: Partial<SelectionToolOptions>): void {
    Object.assign(this.options, changes);
  }

  cursor(_state: CursorState): string {
    return 'crosshair';
  }

  protected docPoint(e: ToolPointerEvent, ctx: ToolContext): Point {
    return ctx.viewport.viewToDoc({ x: e.x, y: e.y });
  }

  /** Starts moving the selection outline when the press is inside it (New, no modifiers). */
  protected startMove(e: ToolPointerEvent, ctx: ToolContext): boolean {
    const doc = ctx.document;
    if (!doc?.selection || modeFor(e, this.options.mode) !== 'new' || e.primaryKey) return false;
    const p = this.docPoint(e, ctx);
    if (doc.selection.value(Math.floor(p.x), Math.floor(p.y), doc.canvasRect) < 128) return false;
    this.#move = { start: p, startView: { x: e.x, y: e.y }, moved: false, dx: 0, dy: 0 };
    return true;
  }

  /** While moving the outline: returns false when no move is in progress. */
  protected continueMove(e: ToolPointerEvent, ctx: ToolContext): boolean {
    const move = this.#move;
    if (!move) return false;
    if (Math.hypot(e.x - move.startView.x, e.y - move.startView.y) >= CLICK_SLOP * ctx.devicePixelRatio)
      move.moved = true;
    if (!move.moved) return true;
    const p = this.docPoint(e, ctx);
    move.dx = Math.round(p.x - move.start.x);
    move.dy = Math.round(p.y - move.start.y);
    ctx.setSelectionPreview({ kind: 'move', dx: move.dx, dy: move.dy });
    return true;
  }

  /** Ends moving the outline; a click without moving deselects, as anywhere else. */
  protected endMove(ctx: ToolContext): boolean {
    const move = this.#move;
    if (!move) return false;
    this.#move = null;
    ctx.setSelectionPreview(null);
    if (!move.moved) this.clicked(ctx, 'new');
    else if (move.dx !== 0 || move.dy !== 0)
      ctx.execute({ name: 'moveSelection', params: { dx: move.dx, dy: move.dy } });
    return true;
  }

  protected cancelMove(): void {
    this.#move = null;
  }

  /** Commits a drawn shape as one history step. */
  protected commit(ctx: ToolContext, shape: SelectionShape, mode: SelectionMode): void {
    ctx.execute({
      name: 'selectShape',
      params: {
        tool: this.kind,
        shape: shape,
        mode,
        feather: this.options.feather,
        antiAlias: this.options.antiAlias,
      },
    });
  }

  /** A click that drew nothing: deselects with New. */
  protected clicked(ctx: ToolContext, mode: SelectionMode): void {
    if (mode === 'new' && ctx.document?.selection) ctx.execute({ name: 'deselect', params: {} });
  }

  cancel(ctx: ToolContext): void {
    this.#move = null;
    ctx.setSelectionPreview(null);
  }
}
