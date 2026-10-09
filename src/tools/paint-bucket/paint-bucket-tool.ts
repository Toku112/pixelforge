/**
 * Paint Bucket tool (G, grouped with the Gradient tool).
 *
 * Behaviour (own summary of the reference app):
 * - Click the image: the area around the click whose colour is close to the clicked
 *   colour fills with the foreground colour or a pattern — inside the selection, if
 *   there is one. Alt/Option-click picks up the foreground colour instead.
 * - Options: Foreground or Pattern (with its picker), Mode (blend modes, Behind and
 *   Clear) and Opacity, Tolerance (0–255, default 32), Anti-alias, Contiguous (only
 *   what joins the click, otherwise every such pixel) and All Layers (compare the
 *   colours of the whole image rather than the active layer's).
 * - The fill happens on the active layer; locked transparency keeps its alpha.
 */
import { colorToSamples } from '../../core/color/color';
import type { JsonObject } from '../../core/commands/command';
import { layerCapabilities, type LayerBlendMode } from '../../core/document/layers';
import { DEFAULT_PATTERN_ID } from '../../core/pattern/pattern';
import { ColorSampler } from '../eyedropper/sampler';
import { BUCKET_CURSOR, EYEDROPPER_CURSOR } from '../paint/cursors';
import type { CursorState, Tool, ToolContext, ToolPointerEvent } from '../types';

export type BucketSource = 'foreground' | 'pattern';

export interface PaintBucketOptions {
  source: BucketSource;
  /** The pattern filled when the source is Pattern. */
  patternId: string;
  mode: LayerBlendMode | 'behind' | 'clear';
  /** 0–1. */
  opacity: number;
  /** 0–255. */
  tolerance: number;
  antiAlias: boolean;
  contiguous: boolean;
  allLayers: boolean;
}

export const DEFAULT_PAINT_BUCKET_OPTIONS: Readonly<PaintBucketOptions> = Object.freeze({
  source: 'foreground',
  patternId: DEFAULT_PATTERN_ID,
  mode: 'normal',
  opacity: 1,
  tolerance: 32,
  antiAlias: true,
  contiguous: true,
  allLayers: false,
});

export class PaintBucketTool implements Tool {
  readonly id = 'paint-bucket';
  readonly name = 'Paint Bucket Tool';
  readonly key = 'G';
  readonly options: PaintBucketOptions = { ...DEFAULT_PAINT_BUCKET_OPTIONS };
  readonly #sampler = new ColorSampler();

  setOptions(changes: Partial<PaintBucketOptions>): void {
    Object.assign(this.options, changes);
  }

  cursor(state: CursorState): string {
    return state.altKey || this.#sampler.active ? EYEDROPPER_CURSOR : BUCKET_CURSOR;
  }

  busy(): boolean {
    return this.#sampler.active;
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    const doc = ctx.document;
    if (!doc) return;
    if (e.altKey) {
      this.#sampler.begin(e, ctx, 'foreground');
      return;
    }
    const layer = doc.activeLayer;
    if (layer?.kind !== 'pixel' || !layerCapabilities(layer).editPixels) {
      ctx.report(
        'Paint Bucket Tool',
        layer?.kind === 'pixel'
          ? 'The area cannot be filled because the layer is locked.'
          : 'The Paint Bucket needs a pixel layer: choose one in the Layers panel.',
      );
      return;
    }
    const p = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    // Off the canvas, or outside the selection: nothing to fill.
    if (
      doc.selection
        ? doc.selection.value(x, y, doc.canvasRect) === 0
        : !(x >= 0 && y >= 0 && x < doc.width && y < doc.height)
    )
      return;
    let params: JsonObject;
    try {
      params = this.params({ x, y }, ctx);
    } catch (error) {
      ctx.report('Paint Bucket Tool', error instanceof Error ? error.message : String(error));
      return;
    }
    ctx.execute({ name: 'paintBucket', params });
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.#sampler.move(e, ctx);
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    this.#sampler.end(e, ctx);
  }

  /** The command's parameters for a click at a document pixel (the foreground colour taken now). */
  params(at: { x: number; y: number }, ctx: Pick<ToolContext, 'colors' | 'document'>): JsonObject {
    const o = this.options;
    const doc = ctx.document;
    const fill: JsonObject =
      o.source === 'pattern'
        ? { pattern: o.patternId }
        : {
            color: doc
              ? colorToSamples(ctx.colors?.get('foreground') ?? { r: 0, g: 0, b: 0 }, doc.mode, doc.depth)
              : [],
          };
    return {
      point: { x: at.x, y: at.y },
      tolerance: o.tolerance,
      contiguous: o.contiguous,
      antiAlias: o.antiAlias,
      allLayers: o.allLayers,
      ...fill,
      mode: o.mode,
      opacity: o.opacity,
    };
  }

  cancel(ctx: ToolContext): void {
    this.#sampler.cancel(ctx);
  }

  deactivate(ctx: ToolContext): void {
    this.cancel(ctx);
  }

  presetOptions(): unknown {
    return { ...this.options };
  }

  applyPresetOptions(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const r = raw as Record<string, unknown>;
    const o = this.options;
    this.setOptions({
      source: r['source'] === 'pattern' ? 'pattern' : 'foreground',
      patternId: typeof r['patternId'] === 'string' ? r['patternId'] : o.patternId,
      mode: typeof r['mode'] === 'string' ? (r['mode'] as PaintBucketOptions['mode']) : o.mode,
      opacity: typeof r['opacity'] === 'number' ? Math.min(1, Math.max(0.01, r['opacity'])) : o.opacity,
      tolerance:
        typeof r['tolerance'] === 'number' ? Math.min(255, Math.max(0, Math.round(r['tolerance']))) : o.tolerance,
      antiAlias: r['antiAlias'] !== false,
      contiguous: r['contiguous'] !== false,
      allLayers: r['allLayers'] === true,
    });
  }
}
