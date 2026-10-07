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
import { DabSpacer, type BrushSettings } from '../../paint/brush';
import { dabTiles, type StrokeSetup } from '../../paint/stroke';
import { CommandUnavailableError, type Command, type CommandContext, type JsonObject } from '../command';
import type { CommandDefinition } from '../registry';
import { LayerTileDiff } from '../tile-diff';

export type PaintTool = 'brush' | 'eraser';

export interface StrokeParams {
  tool: PaintTool;
  /** Pointer samples: x, y, pressure, x, y, pressure, … (document px). */
  points: number[];
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

/** How the worker paints a stroke on `layer`. */
export function strokeSetup(doc: ImageDocument, layer: PixelLayer, params: StrokeParams): StrokeSetup {
  return {
    format: layer.buffer.format,
    color: params.color,
    erase: params.tool === 'eraser',
    opacity: params.brush.opacity,
    flow: params.brush.flow,
    hardness: params.brush.hardness,
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
    const spacer = new DabSpacer(this.#params.brush);
    const pts = this.#params.points;
    const dabs = [];
    for (let i = 0; i < pts.length; i += 3)
      dabs.push(...spacer.add({ x: pts[i]!, y: pts[i + 1]!, pressure: pts[i + 2]! }));
    const coords = dabTiles(dabs, layer.offsetX, layer.offsetY);
    const diff = new LayerTileDiff(layer.id);
    for (const [tx, ty] of coords) diff.captureBefore(doc, tx, ty);
    const tiles = coords.map(([tx, ty]) => layer.buffer.writableTile(tx, ty).data);
    try {
      await services.pixelOps.paintStroke(strokeSetup(doc, layer, this.#params), tiles, coords, dabs);
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

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseBrush(v: unknown): BrushSettings {
  if (typeof v !== 'object' || v === null) throw new Error('paintStroke: brush settings are required');
  const b = v as Record<string, unknown>;
  const num = (key: string, lo: number, hi: number) => {
    const n = b[key];
    if (!isNum(n) || n < lo || n > hi) throw new Error(`paintStroke: brush ${key} must be ${lo}–${hi}`);
    return n;
  };
  return {
    size: num('size', 1, 5000),
    hardness: num('hardness', 0, 1),
    opacity: num('opacity', 0, 1),
    flow: num('flow', 0, 1),
    spacing: num('spacing', 0.01, 10),
    pressureSize: b['pressureSize'] === true,
    pressureOpacity: b['pressureOpacity'] === true,
  };
}

export const paintStrokeCommand: CommandDefinition = {
  name: 'paintStroke',
  isAvailable: (ctx) => paintTarget(ctx.doc) !== undefined,
  create: (ctx, p) => {
    const tool = p['tool'];
    if (tool !== 'brush' && tool !== 'eraser') throw new Error('paintStroke: tool must be brush or eraser');
    const points = p['points'];
    if (!Array.isArray(points) || points.length < 3 || points.length % 3 !== 0 || !points.every(isNum))
      throw new Error('paintStroke: points must be x, y, pressure triplets');
    const color = p['color'];
    if (!Array.isArray(color) || color.length !== ctx.doc.colorChannels || !color.every(isNum))
      throw new Error('paintStroke: color needs one value per colour channel');
    return new PaintStrokeCommand(ctx, { tool, points, brush: parseBrush(p['brush']), color });
  },
};
