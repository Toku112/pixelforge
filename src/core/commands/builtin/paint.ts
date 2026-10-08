/**
 * Brush and Eraser strokes as commands.
 *
 * A stroke is painted live while the pointer moves (see app/paint-session.ts) and
 * then recorded with `preparedStroke`, which keeps the tile diff already made.
 * Its descriptor — the pointer samples, brush settings and colour — repaints the
 * same stroke when an Action replays it.
 */
import type { ImageDocument } from '../../document/document';
import { effectiveLocks, layerCapabilities, type PixelLayer } from '../../document/layers';
import type { Tile } from '../../document/tile';
import { LAYER_BLEND_MODES } from '../../document/layers';
import {
  DEFAULT_BRUSH,
  DabSpacer,
  POINT_FIELDS,
  unpackPoints,
  type BrushMode,
  type BrushSettings,
  type BrushTip,
} from '../../paint/brush';
import { dabTiles, type StrokeSetup } from '../../paint/stroke';
import { CommandUnavailableError, type Command, type CommandContext, type JsonObject } from '../command';
import type { CommandDefinition } from '../registry';
import { LayerTileDiff } from '../tile-diff';

export type PaintTool = 'brush' | 'eraser';

export interface StrokeParams {
  tool: PaintTool;
  /** Pointer samples, `stride` values each (see POINT_FIELDS; 3 = the older x, y, pressure). */
  points: number[];
  stride: number;
  brush: BrushSettings;
  /** Colour samples: the brush colour, or the background colour the eraser paints where alpha cannot change. */
  color: number[];
}

export const PAINT_LABELS: Record<PaintTool, string> = { brush: 'Brush Tool', eraser: 'Eraser' };

/** The layer a stroke paints on: the active pixel layer, if its pixels may change. */
export function paintTarget(doc: ImageDocument): PixelLayer | undefined {
  const layer = doc.activeLayer;
  return layer?.kind === 'pixel' && layerCapabilities(layer).editPixels ? layer : undefined;
}

/** How the worker paints a stroke on `layer`; `tip` is the brush's sampled tip, if it has one. */
export function strokeSetup(
  doc: ImageDocument,
  layer: PixelLayer,
  params: Omit<StrokeParams, 'points' | 'stride'>,
  tip: BrushTip | null,
): StrokeSetup {
  return {
    format: layer.buffer.format,
    color: params.color,
    erase: params.tool === 'eraser',
    opacity: params.brush.opacity,
    flow: params.brush.flow,
    hardness: params.brush.hardness,
    mode: params.brush.mode,
    tip: tip ? { width: tip.width, height: tip.height, data: tip.data } : null,
    lockAlpha: effectiveLocks(layer).transparency,
    offsetX: layer.offsetX,
    offsetY: layer.offsetY,
    selection: doc.selection ? { mask: doc.selection.data, canvas: doc.canvasRect } : null,
  };
}

export function strokeDescriptor(params: StrokeParams): { name: string; params: JsonObject } {
  return { name: 'paintStroke', params: params as unknown as JsonObject };
}

class PaintStrokeCommand implements Command {
  readonly label: string;
  readonly descriptor: { name: string; params: JsonObject };
  readonly #ctx: CommandContext;
  readonly #params: StrokeParams;
  #diff: LayerTileDiff | undefined;

  constructor(ctx: CommandContext, params: StrokeParams, prepared?: LayerTileDiff) {
    this.#ctx = ctx;
    this.#params = params;
    this.#diff = prepared;
    this.label = PAINT_LABELS[params.tool];
    this.descriptor = strokeDescriptor(params);
  }

  get undoBytes(): number {
    return this.#diff?.bytes ?? 0;
  }

  async execute(): Promise<void> {
    if (this.#diff) return; // painted live already
    const { doc, services } = this.#ctx;
    const layer = paintTarget(doc);
    if (!layer) throw new CommandUnavailableError('Painting needs an editable pixel layer');
    const tip = resolveTip(this.#params.brush, services.brushTips);
    const spacer = new DabSpacer(this.#params.brush);
    const dabs = unpackPoints(this.#params.points, this.#params.stride).flatMap((p) => spacer.add(p));
    const coords = dabTiles(dabs, layer.offsetX, layer.offsetY, tip !== null);
    const diff = new LayerTileDiff(layer.id);
    for (const [tx, ty] of coords) diff.captureBefore(doc, tx, ty);
    const tiles = coords.map(([tx, ty]) => layer.buffer.writableTile(tx, ty).data);
    try {
      await services.pixelOps.paintStroke(strokeSetup(doc, layer, this.#params, tip), tiles, coords, dabs);
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

/** A stroke already painted live, as a history step holding its tile diff. */
export function preparedStroke(ctx: CommandContext, params: StrokeParams, diff: LayerTileDiff): Command {
  return new PaintStrokeCommand(ctx, params, diff);
}

/** The brush's sampled tip from the library (null for the round tip). */
export function resolveTip(
  brush: BrushSettings,
  tips: { get(id: string): BrushTip | undefined } | undefined,
): BrushTip | null {
  if (brush.tip === null) return null;
  const tip = tips?.get(brush.tip);
  if (!tip) throw new CommandUnavailableError('The brush tip this stroke uses is not in the brush library');
  return tip;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const BRUSH_MODES: readonly BrushMode[] = [...LAYER_BLEND_MODES, 'behind', 'clear'];

function parseBrush(v: unknown): BrushSettings {
  if (typeof v !== 'object' || v === null) throw new Error('paintStroke: brush settings are required');
  const b = v as Record<string, unknown>;
  const num = (key: string, lo: number, hi: number) => {
    const n = b[key];
    if (!isNum(n) || n < lo || n > hi) throw new Error(`paintStroke: brush ${key} must be ${lo}–${hi}`);
    return n;
  };
  // Settings added later default as before, so older recordings still replay.
  const optional = (key: string, lo: number, hi: number, fallback: number) =>
    b[key] === undefined ? fallback : num(key, lo, hi);
  const tip = b['tip'];
  if (tip !== undefined && tip !== null && typeof tip !== 'string')
    throw new Error('paintStroke: brush tip must be an id');
  const mode = b['mode'] ?? 'normal';
  if (!BRUSH_MODES.includes(mode as BrushMode)) throw new Error('paintStroke: unknown brush mode');
  return {
    size: num('size', 1, 5000),
    hardness: num('hardness', 0, 1),
    opacity: num('opacity', 0, 1),
    flow: num('flow', 0, 1),
    spacing: num('spacing', 0.01, 10),
    pressureSize: b['pressureSize'] === true,
    pressureOpacity: b['pressureOpacity'] === true,
    angle: optional('angle', -180, 180, DEFAULT_BRUSH.angle),
    roundness: optional('roundness', 0.01, 1, DEFAULT_BRUSH.roundness),
    flipX: b['flipX'] === true,
    flipY: b['flipY'] === true,
    tip: tip ?? null,
    mode: mode as BrushMode,
  };
}

export const paintStrokeCommand: CommandDefinition = {
  name: 'paintStroke',
  isAvailable: (ctx) => paintTarget(ctx.doc) !== undefined,
  create: (ctx, p) => {
    const tool = p['tool'];
    if (tool !== 'brush' && tool !== 'eraser') throw new Error('paintStroke: tool must be brush or eraser');
    const points = p['points'];
    const stride = p['stride'] ?? 3;
    if (stride !== 3 && stride !== POINT_FIELDS.length)
      throw new Error(`paintStroke: stride must be 3 or ${POINT_FIELDS.length}`);
    if (!Array.isArray(points) || points.length < stride || points.length % stride !== 0 || !points.every(isNum))
      throw new Error('paintStroke: points must be groups of x, y, pressure (…) values');
    const color = p['color'];
    if (!Array.isArray(color) || color.length !== ctx.doc.colorChannels || !color.every(isNum))
      throw new Error('paintStroke: color needs one value per colour channel');
    return new PaintStrokeCommand(ctx, { tool, points, stride, brush: parseBrush(p['brush']), color });
  },
};
