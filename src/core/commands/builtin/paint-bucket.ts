/**
 * The Paint Bucket tool's fill (History: "Paint Bucket").
 *
 * Behaviour (own summary of the reference app): a click fills the pixels whose colour
 * is close to the colour clicked — within Tolerance (0–255), joined to the click
 * (Contiguous) or anywhere in the layer, with soft edges when anti-aliased — with the
 * foreground colour or a pattern, blended with a mode and opacity. The colours compared
 * are the active layer's own (as if at full opacity), or with All Layers what all
 * visible layers show together; either way only the active layer changes. The fill
 * stays inside the selection, and layers with locked transparency (and the Background)
 * keep their alpha.
 *
 * The descriptor holds the click point and the fill colour as document values, so a
 * replay fills the same area with the same colour.
 */
import { planFromDocument, planNode, type FlattenPlan } from '../../composite/flatten';
import {
  LAYER_BLEND_MODES,
  effectiveLocks,
  layerCapabilities,
  type LayerBlendMode,
  type PixelLayer,
} from '../../document/layers';
import type { Tile } from '../../document/tile';
import type { FillSpec } from '../../paint/fill';
import { builtInPattern, patternSamples } from '../../pattern/pattern';
import type { BucketOptions } from '../../selection/bucket';
import { Selection } from '../../selection/selection';
import { CommandUnavailableError, type Command, type CommandContext, type JsonObject } from '../command';
import { canvasLayerTiles, selectedLayerTiles } from '../pixel-targets';
import type { CommandDefinition } from '../registry';
import { LayerTileDiff } from '../tile-diff';

export interface PaintBucketParams extends BucketOptions {
  /** Where the click was (document coordinates). */
  point: { x: number; y: number };
  /** Compare what all visible layers show, not only the active layer. */
  allLayers: boolean;
  /** Colour samples of the fill (when no pattern). */
  color: number[];
  /** A pattern (by id) instead of the colour. */
  pattern?: string;
  /** A blend mode, or Behind / Clear (layers with editable transparency). */
  mode: LayerBlendMode | 'behind' | 'clear';
  /** 0–1. */
  opacity: number;
}

function target(ctx: CommandContext): PixelLayer | undefined {
  const layer = ctx.doc.activeLayer;
  return layer?.kind === 'pixel' && layerCapabilities(layer).editPixels ? layer : undefined;
}

/** The colours the click is compared with: the active layer as it is (full opacity, Normal), or the whole image. */
function comparedImage(ctx: CommandContext, layer: PixelLayer, allLayers: boolean): FlattenPlan {
  if (allLayers) return planFromDocument(ctx.doc);
  const node = planNode(layer);
  return {
    ...planFromDocument(ctx.doc, []),
    layers: [{ ...node, visible: true, opacity: 1, fillOpacity: 1, blendMode: 'normal' }],
  };
}

class PaintBucketCommand implements Command {
  readonly label = 'Paint Bucket';
  readonly descriptor: { name: string; params: JsonObject };
  readonly #ctx: CommandContext;
  readonly #params: PaintBucketParams;
  #diff: LayerTileDiff | undefined;

  constructor(ctx: CommandContext, params: PaintBucketParams) {
    this.#ctx = ctx;
    this.#params = params;
    this.descriptor = { name: 'paintBucket', params: params as unknown as JsonObject };
  }

  get undoBytes(): number {
    return this.#diff?.bytes ?? 0;
  }

  async execute(): Promise<void> {
    const { doc, services } = this.#ctx;
    const layer = target(this.#ctx);
    if (!layer) throw new CommandUnavailableError('The Paint Bucket needs an editable pixel layer');
    const p = this.#params;
    const { point, pattern: patternId, color, mode, opacity } = p;
    let spec: FillSpec = { color, mode, opacity, preserveTransparency: effectiveLocks(layer).transparency };
    if (patternId !== undefined) {
      const pattern = services.patterns?.get(patternId) ?? builtInPattern(patternId);
      if (!pattern) throw new CommandUnavailableError('The pattern of this fill is not in the pattern library');
      spec = {
        ...spec,
        pattern: { width: pattern.width, height: pattern.height, data: patternSamples(pattern, doc.mode, doc.depth) },
      };
    } else if (color.length !== doc.colorChannels)
      throw new Error('paintBucket: color needs one value per colour channel');

    const area = await services.pixelOps.bucketMask(
      comparedImage(this.#ctx, layer, p.allLayers),
      point,
      { tolerance: p.tolerance, contiguous: p.contiguous, antiAlias: p.antiAlias },
      doc.selection?.data ?? null,
      doc.canvasRect,
    );
    // Outside the canvas or the selection: nothing to fill.
    if (!area) throw new CommandUnavailableError('There is nothing to fill there');
    const { coords, through } = selectedLayerTiles(doc, layer, new Selection(area), canvasLayerTiles(doc, layer));
    const diff = new LayerTileDiff(layer.id);
    for (const [tx, ty] of coords) diff.captureBefore(doc, tx, ty);
    const tiles = coords.map(([tx, ty]) => layer.buffer.writableTile(tx, ty).data);
    try {
      await services.pixelOps.fill(tiles, layer.buffer.format, { ...through, coords }, spec, doc.depth === 32);
    } catch (error) {
      diff.undo(doc);
      throw error;
    }
    for (const [tx, ty] of coords) layer.buffer.markChanged(tx, ty);
    diff.captureAfter(doc);
    this.#diff = diff;
  }

  retainedTiles(): Iterable<Tile> {
    return this.#diff?.tiles() ?? [];
  }

  undo(): void {
    this.#diff?.undo(this.#ctx.doc);
  }

  redo(): void {
    this.#diff?.redo(this.#ctx.doc);
  }
}

function flag(v: unknown, fallback: boolean, name: string): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new Error(`paintBucket: ${name} must be true or false`);
  return v;
}

export const paintBucketCommand: CommandDefinition = {
  name: 'paintBucket',
  isAvailable: (ctx) => target(ctx) !== undefined,
  create: (ctx, p) => {
    const at = p['point'] as { x?: unknown; y?: unknown } | null | undefined;
    if (typeof at?.x !== 'number' || typeof at.y !== 'number' || !Number.isFinite(at.x) || !Number.isFinite(at.y))
      throw new Error('paintBucket: point must be a point');
    const pattern = p['pattern'];
    if (pattern !== undefined && typeof pattern !== 'string')
      throw new Error('paintBucket: pattern must be a pattern id');
    const raw = p['color'] ?? (pattern !== undefined ? [] : undefined);
    if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'number' && Number.isFinite(v)))
      throw new Error('paintBucket: color must be a list of numbers');
    const mode = p['mode'] ?? 'normal';
    if (!(LAYER_BLEND_MODES as readonly unknown[]).includes(mode) && mode !== 'behind' && mode !== 'clear')
      throw new Error('paintBucket: mode is not a blend mode');
    const opacity = p['opacity'] ?? 1;
    if (typeof opacity !== 'number' || !(opacity >= 0 && opacity <= 1))
      throw new Error('paintBucket: opacity must be 0–1');
    const tolerance = p['tolerance'] ?? 32;
    if (typeof tolerance !== 'number' || !(tolerance >= 0 && tolerance <= 255))
      throw new Error('paintBucket: tolerance must be 0–255');
    return new PaintBucketCommand(ctx, {
      point: { x: at.x, y: at.y },
      tolerance,
      contiguous: flag(p['contiguous'], true, 'contiguous'),
      antiAlias: flag(p['antiAlias'], true, 'antiAlias'),
      allLayers: flag(p['allLayers'], false, 'allLayers'),
      color: raw as number[],
      ...(pattern !== undefined ? { pattern } : {}),
      mode: mode as PaintBucketParams['mode'],
      opacity,
    });
  },
};
