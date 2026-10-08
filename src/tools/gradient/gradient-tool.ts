/**
 * Gradient tool (G), classic mode.
 *
 * Behaviour (own summary of the reference app):
 * - Drag across the image: the gradient runs from where the drag starts to where it
 *   ends, filling the selection (or the whole layer). A line shows the drag; Shift
 *   keeps it to multiples of 45°.
 * - Options: the gradient (picker; click its preview to edit it), the shape (linear,
 *   radial, angle, reflected, diamond), Mode and Opacity, Reverse, Dither, Transparency
 *   and Method.
 * - The foreground and background stops take the colours current when you drag.
 */
import { layerCapabilities, type LayerBlendMode } from '../../core/document/layers';
import {
  FOREGROUND_TO_BACKGROUND,
  GRADIENT_METHODS,
  GRADIENT_SHAPES,
  cloneGradient,
  parseGradient,
  resolveGradient,
  type Gradient,
  type GradientMethod,
  type GradientShape,
} from '../../core/paint/gradient';
import type { JsonObject } from '../../core/commands/command';
import type { CursorState, Tool, ToolContext, ToolPointerEvent } from '../types';

export interface GradientOptions {
  /** The gradient used (foreground/background stops unresolved). */
  gradient: Gradient;
  /** The preset it came from (the picker highlights it), or null after editing. */
  presetId: string | null;
  shape: GradientShape;
  mode: LayerBlendMode | 'behind' | 'clear';
  /** 0–1. */
  opacity: number;
  reverse: boolean;
  dither: boolean;
  transparency: boolean;
  method: GradientMethod;
}

export const DEFAULT_GRADIENT_OPTIONS: Readonly<GradientOptions> = Object.freeze({
  gradient: FOREGROUND_TO_BACKGROUND,
  presetId: 'pf-grad-foreground-to-background',
  shape: 'linear',
  mode: 'normal',
  opacity: 1,
  reverse: false,
  dither: true,
  transparency: true,
  method: 'perceptual',
});

type Point = { x: number; y: number };

/** The end point kept to a multiple of 45° from the start (the drag projected onto that direction). */
export function constrain45(start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  const reach = dx * Math.cos(a) + dy * Math.sin(a);
  return { x: start.x + Math.cos(a) * reach, y: start.y + Math.sin(a) * reach };
}

export class GradientTool implements Tool {
  readonly id = 'gradient';
  readonly name = 'Gradient Tool';
  readonly key = 'G';
  readonly options: GradientOptions = {
    ...DEFAULT_GRADIENT_OPTIONS,
    gradient: cloneGradient(FOREGROUND_TO_BACKGROUND),
  };
  #drag: { start: Point; end: Point } | null = null;

  setOptions(changes: Partial<GradientOptions>): void {
    Object.assign(this.options, changes);
  }

  cursor(_state: CursorState): string {
    return 'crosshair';
  }

  busy(): boolean {
    return this.#drag !== null;
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    const doc = ctx.document;
    if (!doc) return;
    const layer = doc.activeLayer;
    if (layer?.kind !== 'pixel' || !layerCapabilities(layer).editPixels) {
      ctx.report(
        'Gradient Tool',
        layer?.kind === 'pixel'
          ? 'The gradient cannot be drawn because the layer is locked.'
          : 'The gradient needs a pixel layer: choose one in the Layers panel.',
      );
      return;
    }
    const p = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
    this.#drag = { start: p, end: p };
    ctx.setGradientLine({ start: p, end: p });
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!this.#drag) return;
    const p = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
    this.#drag.end = e.shiftKey ? constrain45(this.#drag.start, p) : p;
    ctx.setGradientLine({ ...this.#drag });
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!this.#drag) return;
    this.onPointerMove(e, ctx);
    const { start, end } = this.#drag;
    this.#drag = null;
    ctx.setGradientLine(null);
    // A click without a drag (under a screen pixel) draws nothing.
    if (Math.hypot(end.x - start.x, end.y - start.y) * ctx.viewport.zoom < 1) return;
    ctx.execute({ name: 'gradient', params: this.params(start, end, ctx) });
  }

  /** The command's parameters for a drag (foreground/background stops resolved now). */
  params(start: Point, end: Point, ctx: Pick<ToolContext, 'colors'>): JsonObject {
    const o = this.options;
    const fg = ctx.colors?.get('foreground') ?? { r: 0, g: 0, b: 0 };
    const bg = ctx.colors?.get('background') ?? { r: 1, g: 1, b: 1 };
    return {
      gradient: resolveGradient(o.gradient, fg, bg) as unknown as JsonObject,
      method: o.method,
      shape: o.shape,
      start: { x: start.x, y: start.y },
      end: { x: end.x, y: end.y },
      reverse: o.reverse,
      dither: o.dither,
      transparency: o.transparency,
      mode: o.mode,
      opacity: o.opacity,
    };
  }

  cancel(ctx: ToolContext): void {
    this.#drag = null;
    ctx.setGradientLine(null);
  }

  deactivate(ctx: ToolContext): void {
    this.cancel(ctx);
  }

  presetOptions(): unknown {
    return JSON.parse(JSON.stringify(this.options)) as unknown;
  }

  applyPresetOptions(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const r = raw as Record<string, unknown>;
    const pick = <T extends string>(v: unknown, list: readonly (readonly [T, string])[], fallback: T): T =>
      list.some(([k]) => k === v) ? (v as T) : fallback;
    let gradient = this.options.gradient;
    try {
      gradient = parseGradient(r['gradient']);
    } catch {
      // Keep the current gradient.
    }
    this.setOptions({
      gradient,
      presetId: typeof r['presetId'] === 'string' ? r['presetId'] : null,
      shape: pick(r['shape'], GRADIENT_SHAPES, this.options.shape),
      mode: typeof r['mode'] === 'string' ? (r['mode'] as GradientOptions['mode']) : this.options.mode,
      opacity: typeof r['opacity'] === 'number' ? Math.min(1, Math.max(0.01, r['opacity'])) : this.options.opacity,
      reverse: r['reverse'] === true,
      dither: r['dither'] !== false,
      transparency: r['transparency'] !== false,
      method: pick(r['method'], GRADIENT_METHODS, this.options.method),
    });
  }
}
