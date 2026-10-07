/**
 * Brush (B) and Eraser (E) tools.
 *
 * Behaviour (own summary of the reference app):
 * - Drag to paint with the foreground colour (Brush) or to erase (Eraser: to
 *   transparency, or to the background colour on the Background and on layers
 *   with locked transparency). Each stroke is one History step.
 * - Shift-click paints a straight line from the end of the previous stroke.
 * - Painting stays inside the selection, if there is one.
 * - The brush outline follows the pointer.
 */
import type { PaintTool } from '../../core/commands/builtin/paint';
import { DEFAULT_BRUSH, DabSpacer, type BrushSettings, type StrokePoint } from '../../core/paint/brush';
import type { CursorState, PaintStroke, Tool, ToolContext, ToolPointerEvent } from '../types';

export class PaintingTool implements Tool {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly kind: PaintTool;
  readonly options: BrushSettings;
  #stroke: { session: PaintStroke; spacer: DabSpacer; points: StrokePoint[] } | null = null;
  /** End of the last stroke, for Shift-click lines. */
  #lastEnd: StrokePoint | null = null;

  constructor(kind: PaintTool) {
    this.kind = kind;
    this.id = kind;
    this.name = kind === 'brush' ? 'Brush Tool' : 'Eraser Tool';
    this.key = kind === 'brush' ? 'B' : 'E';
    this.options = { ...DEFAULT_BRUSH, size: kind === 'brush' ? 30 : 50 };
  }

  setOptions(changes: Partial<BrushSettings>): void {
    Object.assign(this.options, changes);
  }

  cursor(_state: CursorState): string {
    return 'crosshair';
  }

  busy(): boolean {
    return this.#stroke !== null;
  }

  #point(e: ToolPointerEvent, ctx: ToolContext): StrokePoint {
    const p = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
    return { x: p.x, y: p.y, pressure: e.pressure };
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!ctx.document || !ctx.paint || this.#stroke) return;
    const session = ctx.paint.begin(this.kind, this.options);
    if (!session) return;
    const spacer = new DabSpacer(this.options);
    const p = this.#point(e, ctx);
    const points: StrokePoint[] = [];
    this.#stroke = { session, spacer, points };
    if (e.shiftKey && this.#lastEnd) {
      // A straight line from where the last stroke ended.
      points.push(this.#lastEnd);
      session.add(spacer.add(this.#lastEnd));
    }
    points.push(p);
    session.add(spacer.add(p));
    ctx.setBrushOutline({ x: p.x, y: p.y, size: this.options.size });
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    const stroke = this.#stroke;
    const p = this.#point(e, ctx);
    ctx.setBrushOutline({ x: p.x, y: p.y, size: this.options.size });
    if (!stroke) return;
    stroke.points.push(p);
    stroke.session.add(stroke.spacer.add(p));
  }

  onPointerUp(_e: ToolPointerEvent, _ctx: ToolContext): void {
    const stroke = this.#stroke;
    this.#stroke = null;
    if (!stroke) return;
    this.#lastEnd = stroke.points.at(-1) ?? null;
    void stroke.session.end(stroke.points).catch(() => {
      // The session already restored the layer; the host reports problems.
    });
  }

  onPointerHover(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!ctx.document) return;
    const p = this.#point(e, ctx);
    ctx.setBrushOutline({ x: p.x, y: p.y, size: this.options.size });
  }

  onPointerLeave(ctx: ToolContext): void {
    ctx.setBrushOutline(null);
  }

  cancel(ctx: ToolContext): void {
    const stroke = this.#stroke;
    this.#stroke = null;
    ctx.setBrushOutline(null);
    if (stroke) void stroke.session.cancel();
  }
}
