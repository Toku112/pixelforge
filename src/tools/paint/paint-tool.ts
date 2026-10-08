/**
 * Brush and Pencil (B, Shift+B to switch) and Eraser (E) tools.
 *
 * Behaviour (own summary of the reference app):
 * - Drag to paint with the foreground colour (Brush) or to erase (Eraser: to
 *   transparency, or to the background colour on the Background and on layers
 *   with locked transparency). Each stroke is one History step.
 * - Shift-click paints a straight line from the end of the previous stroke.
 * - The Pencil paints hard pixels only (no soft or anti-aliased edge). With Auto
 *   Erase, a stroke that starts on the foreground colour paints the background colour.
 * - Eraser modes: Brush, Pencil (hard pixels) and Block (a square of fixed size on
 *   screen, at full strength).
 * - Painting stays inside the selection, if there is one.
 * - The brush outline follows the pointer.
 * - With Build-up (airbrush), holding the pointer still keeps adding paint.
 * - Smoothing (options bar) lets the paint trail the pointer on a string, shown
 *   while painting; the brush's Smoothing setting draws curves through the samples
 *   (see core/paint/smoothing.ts). The smoothed path is what the stroke records.
 * - The cursor follows Preferences > Cursors: the tool's icon, a crosshair, or the
 *   tip's outline (where it paints at least half, or at all); Caps Lock swaps in
 *   the crosshair.
 * - With the Brush, Alt/Option-click (or drag) picks the foreground colour off the
 *   image, as the Eyedropper does (with its options).
 * - Alt+right-drag (Ctrl+Option-drag on macOS) shows the brush HUD: drag left or
 *   right for the size, up (softer) or down (harder) for a round tip's hardness —
 *   or the opacity, by preference and for sampled tips.
 */
import type { PaintTool } from '../../core/commands/builtin/paint';
import { DEFAULT_BRUSH, type BrushSettings, type StrokePoint } from '../../core/paint/brush';
import { DEFAULT_DYNAMICS, StrokeDabber } from '../../core/paint/dynamics';
import {
  CurveSmoother,
  DEFAULT_SMOOTHING,
  StrokeSmoother,
  smoothingRadius,
  type SmoothingOptions,
} from '../../core/paint/smoothing';
import {
  effectivePaintCursor,
  type BrushAdjuster,
  type BrushOutline,
  type CursorState,
  type PaintStroke,
  type Tool,
  type ToolContext,
  type ToolPointerEvent,
} from '../types';
import { BRUSH_CURSOR, ERASER_CURSOR, EYEDROPPER_CURSOR } from './cursors';
import { ColorSampler } from '../eyedropper/sampler';

export class PaintingTool implements Tool {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly kind: PaintTool;
  readonly options: BrushSettings;
  /** Smoothing (options bar) and curves (the brush's Smoothing setting). */
  readonly smoothing: SmoothingOptions = { ...DEFAULT_SMOOTHING };
  /** The brush preset last chosen (the Brushes panel shows it selected), or null. */
  presetId: string | null = null;
  /** Protect Texture (Brush Settings): switching presets keeps the texture's pattern and scale. */
  protectTexture = false;
  /** Pencil: Auto Erase. */
  autoErase = false;
  /** Eraser: what it erases with. */
  eraserMode: 'brush' | 'pencil' | 'block' = 'brush';
  #stroke: {
    session: PaintStroke;
    spacer: StrokeDabber;
    smoother: StrokeSmoother;
    curves: CurveSmoother | null;
    points: StrokePoint[];
    start: number;
  } | null = null;
  /** End of the last stroke, for Shift-click lines. */
  #lastEnd: StrokePoint | null = null;
  /** Alt-click with the Brush: picking the foreground colour. */
  readonly #sampler = new ColorSampler();
  /** While a stroke lasts: Stroke Catch-up and Build-up go on with the pointer at rest. */
  #timer: ReturnType<typeof setInterval> | null = null;
  /** The brush HUD gesture: where it started and the settings then. */
  #adjust: {
    x: number;
    y: number;
    at: { x: number; y: number };
    size: number;
    hardness: number;
    opacity: number;
  } | null = null;

  constructor(kind: PaintTool) {
    this.kind = kind;
    this.id = kind;
    this.name = kind === 'brush' ? 'Brush Tool' : kind === 'pencil' ? 'Pencil Tool' : 'Eraser Tool';
    this.key = kind === 'eraser' ? 'E' : 'B';
    const size = kind === 'brush' ? 30 : kind === 'pencil' ? 1 : 50;
    this.options = {
      ...DEFAULT_BRUSH,
      size,
      aliased: kind === 'pencil',
      dynamics: structuredClone(DEFAULT_DYNAMICS),
    };
    // The Pencil draws exact lines: no smoothing unless asked.
    if (kind === 'pencil') this.smoothing.amount = 0;
  }

  setAutoErase(on: boolean): void {
    this.autoErase = on;
  }

  setEraserMode(mode: 'brush' | 'pencil' | 'block'): void {
    this.eraserMode = mode;
  }

  /**
   * The brush a stroke paints with: the tool's, or for the Eraser's Pencil mode the same with hard
   * pixels, and for Block mode a full-strength square of 16 screen pixels.
   */
  #strokeBrush(ctx: ToolContext): BrushSettings {
    if (this.kind !== 'eraser' || this.eraserMode === 'brush') return this.options;
    if (this.eraserMode === 'pencil') return { ...this.options, aliased: true };
    return {
      ...DEFAULT_BRUSH,
      size: Math.max(1, Math.round((16 * ctx.devicePixelRatio) / ctx.viewport.zoom)),
      tip: 'pf-tip-square',
      aliased: true,
      dynamics: structuredClone(DEFAULT_DYNAMICS),
    };
  }

  setOptions(changes: Partial<BrushSettings>): void {
    Object.assign(this.options, changes);
  }

  setSmoothing(changes: Partial<SmoothingOptions>): void {
    Object.assign(this.smoothing, changes);
  }

  setProtectTexture(on: boolean): void {
    this.protectTexture = on;
  }

  /** The tool's settings for a tool preset (plain data). */
  presetOptions(): unknown {
    return JSON.parse(
      JSON.stringify({
        brush: this.options,
        smoothing: this.smoothing,
        protectTexture: this.protectTexture,
        autoErase: this.autoErase,
        eraserMode: this.eraserMode,
      }),
    );
  }

  /** Applies a tool preset's settings (as from presetOptions). */
  applyPresetOptions(raw: unknown): void {
    const o = (raw ?? {}) as {
      brush?: Partial<BrushSettings>;
      smoothing?: Partial<SmoothingOptions>;
      protectTexture?: boolean;
      autoErase?: boolean;
      eraserMode?: string;
    };
    if (o.brush) this.setOptions(JSON.parse(JSON.stringify(o.brush)) as Partial<BrushSettings>);
    if (o.smoothing) this.setSmoothing(o.smoothing);
    if (typeof o.protectTexture === 'boolean') this.protectTexture = o.protectTexture;
    if (typeof o.autoErase === 'boolean') this.autoErase = o.autoErase;
    if (o.eraserMode === 'brush' || o.eraserMode === 'pencil' || o.eraserMode === 'block')
      this.eraserMode = o.eraserMode;
    this.presetId = null;
  }

  cursor(state: CursorState): string {
    if (this.kind === 'brush' && (state.altKey || this.#sampler.active)) return EYEDROPPER_CURSOR;
    switch (state.paintCursor ?? 'precise') {
      case 'standard':
        return this.kind === 'brush' ? BRUSH_CURSOR : ERASER_CURSOR;
      case 'precise':
        return 'crosshair';
      default:
        return 'none'; // the overlay draws the tip outline (and a crosshair when it is tiny)
    }
  }

  busy(): boolean {
    return this.#stroke !== null || this.#sampler.active;
  }

  #point(e: ToolPointerEvent, ctx: ToolContext, start = e.time ?? performance.now()): StrokePoint {
    const p = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
    return {
      x: p.x,
      y: p.y,
      pressure: e.pressure,
      tiltX: e.tiltX ?? 0,
      tiltY: e.tiltY ?? 0,
      twist: e.twist ?? 0,
      wheel: e.wheel ?? 0,
      time: Math.max(0, (e.time ?? performance.now()) - start),
    };
  }

  /** Paint points (after smoothing) go through the curves, into the record and to the spacer. */
  #feed(points: StrokePoint[]): void {
    const stroke = this.#stroke;
    if (!stroke) return;
    for (const p of points) {
      for (const q of stroke.curves ? stroke.curves.push(p) : [p]) {
        stroke.points.push(q);
        stroke.session.add(stroke.spacer.add(q));
      }
    }
  }

  /**
   * While the stroke lasts and the pointer rests: Stroke Catch-up keeps the paint drifting to it,
   * and Build-up repeats where the paint is with the current time (recorded like any sample), so
   * the spacer keeps adding paint there.
   */
  #startTimer(buildUp: boolean): void {
    this.#stopTimer();
    this.#timer = setInterval(() => {
      const stroke = this.#stroke;
      if (!stroke) return;
      const now = performance.now() - stroke.start;
      this.#feed(stroke.smoother.tick(now));
      const at = stroke.smoother.paint;
      if (buildUp && at) this.#feed([{ ...at, time: Math.max(at.time, now) }]);
    }, 16);
  }

  #stopTimer(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * The cursor at the pointer — ahead of it where the browser predicts the next position — or
   * null when the cursor is the icon or the crosshair (CSS cursors, see `cursor`).
   */
  #outline(e: ToolPointerEvent, ctx: ToolContext, painting = false): BrushOutline | null {
    const prefs = ctx.cursorPreferences;
    const mode = effectivePaintCursor(prefs.painting, e.capsLock ?? false);
    if (mode === 'standard' || mode === 'precise') return null;
    const p = ctx.viewport.viewToDoc(e.predicted ?? { x: e.x, y: e.y });
    const o = this.#strokeBrush(ctx);
    const base = {
      x: p.x,
      y: p.y,
      size: o.size,
      angle: o.angle,
      roundness: o.roundness,
      flipX: o.flipX,
      flipY: o.flipY,
      tip: o.tip,
    };
    // While smoothing, the string from the pointer to where the paint is.
    const smoother = painting ? this.#stroke?.smoother : undefined;
    const paintAt = smoother?.active ? smoother.paint : null;
    const string = paintAt
      ? {
          paintAt: { x: paintAt.x, y: paintAt.y },
          ...(this.smoothing.pulledString ? { stringRadius: smoother!.radius } : {}),
        }
      : {};
    if (painting && prefs.crosshairWhilePainting) return { ...base, ...string, crosshairOnly: true };
    return {
      ...base,
      ...string,
      contour: mode === 'full' ? 'full' : 'normal',
      hardness: o.hardness,
      crosshair: prefs.crosshairInTip,
    };
  }

  readonly adjustBrush: BrushAdjuster = {
    begin: (e, ctx) => {
      if (this.#stroke || !ctx.document) return false;
      const o = this.options;
      const at = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
      this.#adjust = { x: e.x, y: e.y, at, size: o.size, hardness: o.hardness, opacity: o.opacity };
      ctx.setBrushOutline(null);
      this.#showHud(ctx);
      return true;
    },
    move: (e, ctx) => {
      const a = this.#adjust;
      if (!a) return;
      // Horizontally the outline's edge follows the pointer; vertically 1 % per CSS pixel.
      const size = Math.round(a.size + (2 * (e.x - a.x)) / ctx.viewport.zoom);
      const dy = (e.y - a.y) / ctx.devicePixelRatio / 100;
      const changes: Partial<BrushSettings> = { size: Math.min(5000, Math.max(1, size)) };
      const percent = (v: number, lo: number) => Math.round(Math.min(1, Math.max(lo, v)) * 100) / 100;
      if (this.options.tip === null && ctx.cursorPreferences.hudHardness)
        changes.hardness = percent(a.hardness + dy, 0);
      else changes.opacity = percent(a.opacity + dy, 0.01);
      this.setOptions(changes);
      ctx.toolOptionsChanged();
      this.#showHud(ctx);
    },
    end: (ctx) => {
      this.#adjust = null;
      ctx.setBrushHud(null);
    },
  };

  #showHud(ctx: ToolContext): void {
    const a = this.#adjust;
    if (!a) return;
    const o = this.options;
    ctx.setBrushHud({
      x: a.at.x,
      y: a.at.y,
      size: o.size,
      hardness: o.hardness,
      angle: o.angle,
      roundness: o.roundness,
      flipX: o.flipX,
      flipY: o.flipY,
      tip: o.tip,
      color: ctx.cursorPreferences.previewColor,
      lines: [
        `Diameter: ${o.size} px`,
        ...(o.tip === null ? [`Hardness: ${Math.round(o.hardness * 100)}%`] : []),
        `Opacity: ${Math.round(o.opacity * 100)}%`,
      ],
    });
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!ctx.document || this.#stroke) return;
    if (this.kind === 'brush' && e.altKey) {
      ctx.setBrushOutline(null);
      this.#sampler.begin(e, ctx, 'foreground');
      return;
    }
    if (!ctx.paint) return;
    const brush = this.#strokeBrush(ctx);
    const startAt = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
    const session = ctx.paint.begin(
      this.kind,
      brush,
      this.kind === 'pencil' && this.autoErase ? { autoEraseAt: startAt } : undefined,
    );
    if (!session) return;
    const spacer = new StrokeDabber(brush, session.seed, session.colors, session.symmetry);
    const start = e.time ?? performance.now();
    const p = this.#point(e, ctx, start);
    const s = this.smoothing;
    const smoother = new StrokeSmoother(s, smoothingRadius(s, ctx.viewport.zoom, ctx.devicePixelRatio));
    const curves = s.curves ? new CurveSmoother() : null;
    this.#stroke = { session, spacer, smoother, curves, points: [], start };
    if (e.shiftKey && this.#lastEnd) {
      // A straight line from where the last stroke ended.
      this.#feed([{ ...this.#lastEnd, time: 0 }]);
    }
    this.#feed(smoother.add(p));
    const buildUp = !!this.options.dynamics?.buildUp;
    if (buildUp || (smoother.active && s.catchUp && !s.pulledString)) this.#startTimer(buildUp);
    ctx.setBrushOutline(this.#outline(e, ctx, true));
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.#sampler.active) {
      this.#sampler.move(e, ctx);
      return;
    }
    const stroke = this.#stroke;
    if (stroke) this.#feed(stroke.smoother.add(this.#point(e, ctx, stroke.start)));
    ctx.setBrushOutline(this.#outline(e, ctx, stroke !== null));
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.#sampler.active) {
      this.#sampler.end(e, ctx);
      return;
    }
    const stroke = this.#stroke;
    this.#stopTimer();
    if (!stroke) return;
    // Catch-up on Stroke End, then the last stretch of the curve.
    this.#feed(stroke.smoother.end());
    if (stroke.curves) {
      for (const q of stroke.curves.flush()) {
        stroke.points.push(q);
        stroke.session.add(stroke.spacer.add(q));
      }
    }
    this.#stroke = null;
    ctx.setBrushOutline(this.#outline(e, ctx)); // back from the painting cursor
    this.#lastEnd = stroke.points.at(-1) ?? null;
    void stroke.session.end(stroke.points).catch(() => {
      // The session already restored the layer; the host reports problems.
    });
  }

  onPointerHover(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!ctx.document) return;
    // Alt with the Brush shows the Eyedropper instead of the tip.
    ctx.setBrushOutline(this.kind === 'brush' && e.altKey ? null : this.#outline(e, ctx));
  }

  onPointerLeave(ctx: ToolContext): void {
    ctx.setBrushOutline(null);
  }

  activate(ctx: ToolContext): void {
    ctx.showSymmetry(true);
  }

  deactivate(ctx: ToolContext): void {
    ctx.showSymmetry(false);
    ctx.setBrushOutline(null);
  }

  cancel(ctx: ToolContext): void {
    this.#sampler.cancel(ctx);
    const stroke = this.#stroke;
    this.#stroke = null;
    this.#stopTimer();
    ctx.setBrushOutline(null);
    if (stroke) void stroke.session.cancel();
  }
}
