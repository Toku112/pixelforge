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
import type { BrushOutline, CursorState, PaintStroke, Tool, ToolContext, ToolPointerEvent } from '../types';

export class PaintingTool implements Tool {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly kind: PaintTool;
  readonly options: BrushSettings;
  #stroke: { session: PaintStroke; spacer: DabSpacer; points: StrokePoint[]; start: number } | null = null;
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

  #point(e: ToolPointerEvent, ctx: ToolContext, start = e.time ?? 0): StrokePoint {
    const p = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
    return {
      x: p.x,
      y: p.y,
      pressure: e.pressure,
      tiltX: e.tiltX ?? 0,
      tiltY: e.tiltY ?? 0,
      twist: e.twist ?? 0,
      wheel: e.wheel ?? 0,
      time: Math.max(0, (e.time ?? 0) - start),
    };
  }

  /** The cursor at the pointer — ahead of it where the browser predicts the next position. */
  #outline(e: ToolPointerEvent, ctx: ToolContext): BrushOutline {
    const p = ctx.viewport.viewToDoc(e.predicted ?? { x: e.x, y: e.y });
    const o = this.options;
    return {
      x: p.x,
      y: p.y,
      size: o.size,
      angle: o.angle,
      roundness: o.roundness,
      flipX: o.flipX,
      flipY: o.flipY,
      tip: o.tip,
    };
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!ctx.document || !ctx.paint || this.#stroke) return;
    const session = ctx.paint.begin(this.kind, this.options);
    if (!session) return;
    const spacer = new DabSpacer(this.options);
    const start = e.time ?? 0;
    const p = this.#point(e, ctx, start);
    const points: StrokePoint[] = [];
    this.#stroke = { session, spacer, points, start };
    if (e.shiftKey && this.#lastEnd) {
      // A straight line from where the last stroke ended.
      const from = { ...this.#lastEnd, time: 0 };
      points.push(from);
      session.add(spacer.add(from));
    }
    points.push(p);
    session.add(spacer.add(p));
    ctx.setBrushOutline(this.#outline(e, ctx));
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    const stroke = this.#stroke;
    ctx.setBrushOutline(this.#outline(e, ctx));
    if (!stroke) return;
    const p = this.#point(e, ctx, stroke.start);
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
    ctx.setBrushOutline(this.#outline(e, ctx));
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
