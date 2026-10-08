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
import { colorToSamples, type RGB } from '../../color/color';
import type { PixelFormat } from '../../document/pixel-format';
import { builtInPattern, patternGray, type Pattern, type PatternSource } from '../../pattern/pattern';
import { parseSymmetry, type Symmetry } from '../../paint/symmetry';
import { builtInTip } from '../../paint/builtin-tips';
import { StrokeDabber, parseDynamics, type DynamicsColors } from '../../paint/dynamics';
import {
  DEFAULT_BRUSH,
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

export type PaintTool = 'brush' | 'pencil' | 'eraser';

export interface StrokeParams {
  tool: PaintTool;
  /** Pointer samples, `stride` values each (see POINT_FIELDS; 3 = the older x, y, pressure). */
  points: number[];
  stride: number;
  brush: BrushSettings;
  /** Colour samples: the brush colour, or the background colour the eraser paints where alpha cannot change. */
  color: number[];
  /** Seeds the dynamics' randomness, so a replay paints the same dabs. */
  seed: number;
  /** The foreground and background colours (sRGB 0–1), when Color Dynamics vary between them. */
  colors?: { foreground: RGB; background: RGB };
  /** The paint symmetry the stroke was painted with (its mirror images are part of it). */
  symmetry?: Symmetry;
}

export const PAINT_LABELS: Record<PaintTool, string> = { brush: 'Brush Tool', pencil: 'Pencil', eraser: 'Eraser' };

/** The layer a stroke paints on: the active pixel layer, if its pixels may change. */
export function paintTarget(doc: ImageDocument): PixelLayer | undefined {
  const layer = doc.activeLayer;
  return layer?.kind === 'pixel' && layerCapabilities(layer).editPixels ? layer : undefined;
}

/** What a brush takes from the libraries: its sampled tip, the Dual Brush's tip and the Texture's pattern. */
export interface BrushResources {
  tip: BrushTip | null;
  dualTip: BrushTip | null;
  pattern: Pattern | null;
}

const tipData = (tip: BrushTip | null) => (tip ? { width: tip.width, height: tip.height, data: tip.data } : null);

/** How the worker paints a stroke of `brush` in pixels of `format` (the layer and selection parts left out). */
export function brushStrokeSetup(
  brush: BrushSettings,
  tool: PaintTool,
  format: PixelFormat,
  color: number[],
  res: BrushResources,
): Omit<StrokeSetup, 'lockAlpha' | 'offsetX' | 'offsetY' | 'selection'> {
  const d = brush.dynamics;
  const texture = d?.texture.enabled && res.pattern ? d.texture : null;
  return {
    format,
    color,
    erase: tool === 'eraser',
    opacity: brush.opacity,
    flow: brush.flow,
    hardness: brush.hardness,
    mode: brush.mode,
    tip: tipData(res.tip),
    aliased: brush.aliased,
    varyColor: !!d?.color.enabled && tool !== 'eraser',
    varyOpacity: !!d?.transfer.enabled,
    texture:
      texture && res.pattern
        ? {
            width: res.pattern.width,
            height: res.pattern.height,
            gray: patternGray(res.pattern),
            scale: texture.scale,
            brightness: texture.brightness,
            contrast: texture.contrast,
            invert: texture.invert,
            eachTip: texture.eachTip,
            mode: texture.mode,
            depth: texture.depth,
          }
        : null,
    dual: d?.dual.enabled ? { tip: tipData(res.dualTip), hardness: d.dual.hardness, mode: d.dual.mode } : null,
    noise: !!d?.noise,
    wetEdges: !!d?.wetEdges,
  };
}

/** How the worker paints a stroke on `layer`. */
export function strokeSetup(
  doc: ImageDocument,
  layer: PixelLayer,
  params: Omit<StrokeParams, 'points' | 'stride'>,
  res: BrushResources,
): StrokeSetup {
  return {
    ...brushStrokeSetup(params.brush, params.tool, layer.buffer.format, params.color, res),
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
    const res = resolveBrushResources(this.#params.brush, services.brushTips, services.patterns);
    const dabber = new StrokeDabber(
      this.#params.brush,
      this.#params.seed,
      dynamicsColors(doc, this.#params),
      this.#params.symmetry ?? null,
    );
    const dabs = unpackPoints(this.#params.points, this.#params.stride).flatMap((p) => dabber.add(p));
    const coords = dabTiles(dabs, layer.offsetX, layer.offsetY, res.tip !== null, res.dualTip !== null);
    const diff = new LayerTileDiff(layer.id);
    for (const [tx, ty] of coords) diff.captureBefore(doc, tx, ty);
    const tiles = coords.map(([tx, ty]) => layer.buffer.writableTile(tx, ty).data);
    try {
      await services.pixelOps.paintStroke(strokeSetup(doc, layer, this.#params, res), tiles, coords, dabs);
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

/** The colours Color Dynamics vary between, as samples of `doc` (null when the stroke has none). */
export function dynamicsColors(
  doc: ImageDocument,
  params: Pick<StrokeParams, 'colors' | 'tool'>,
): DynamicsColors | null {
  if (!params.colors || params.tool === 'eraser') return null;
  return { ...params.colors, toSamples: (c) => colorToSamples(c, doc.mode, doc.depth) };
}

/** The brush's sampled tip from the library (null for the round tip). */
export function resolveTip(
  brush: BrushSettings,
  tips: { get(id: string): BrushTip | undefined } | undefined,
): BrushTip | null {
  return libraryTip(brush.tip, tips, 'brush tip');
}

function libraryTip(
  id: string | null,
  tips: { get(id: string): BrushTip | undefined } | undefined,
  what: string,
): BrushTip | null {
  if (id === null) return null;
  const tip = tips?.get(id) ?? builtInTip(id);
  if (!tip) throw new CommandUnavailableError(`The ${what} this stroke uses is not in the brush library`);
  return tip;
}

/** Everything the brush takes from the libraries (built-in patterns are always there). */
export function resolveBrushResources(
  brush: BrushSettings,
  tips: { get(id: string): BrushTip | undefined } | undefined,
  patterns: PatternSource | undefined,
): BrushResources {
  const d = brush.dynamics;
  let pattern: Pattern | null = null;
  if (d?.texture.enabled) {
    pattern = patterns?.get(d.texture.pattern) ?? builtInPattern(d.texture.pattern) ?? null;
    if (!pattern)
      throw new CommandUnavailableError('The texture pattern this stroke uses is not in the pattern library');
  }
  return {
    tip: resolveTip(brush, tips),
    dualTip: d?.dual.enabled ? libraryTip(d.dual.tip, tips, 'dual brush tip') : null,
    pattern,
  };
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
    spacingEnabled: b['spacingEnabled'] !== false,
    pressureSize: b['pressureSize'] === true,
    pressureOpacity: b['pressureOpacity'] === true,
    angle: optional('angle', -180, 180, DEFAULT_BRUSH.angle),
    roundness: optional('roundness', 0.01, 1, DEFAULT_BRUSH.roundness),
    flipX: b['flipX'] === true,
    flipY: b['flipY'] === true,
    tip: tip ?? null,
    aliased: b['aliased'] === true,
    mode: mode as BrushMode,
    ...(b['dynamics'] !== undefined ? { dynamics: parseDynamics(b['dynamics']) } : {}),
  };
}

function parseRgb(v: unknown, name: string): RGB {
  const c = v as Partial<RGB> | null;
  if (!c || ![c.r, c.g, c.b].every((x) => isNum(x) && x >= 0 && x <= 1))
    throw new Error(`paintStroke: ${name} must be an RGB colour (0–1)`);
  return { r: c.r!, g: c.g!, b: c.b! };
}

export const paintStrokeCommand: CommandDefinition = {
  name: 'paintStroke',
  isAvailable: (ctx) => paintTarget(ctx.doc) !== undefined,
  create: (ctx, p) => {
    const tool = p['tool'];
    if (tool !== 'brush' && tool !== 'pencil' && tool !== 'eraser')
      throw new Error('paintStroke: tool must be brush, pencil or eraser');
    const points = p['points'];
    const stride = p['stride'] ?? 3;
    if (stride !== 3 && stride !== POINT_FIELDS.length)
      throw new Error(`paintStroke: stride must be 3 or ${POINT_FIELDS.length}`);
    if (!Array.isArray(points) || points.length < stride || points.length % stride !== 0 || !points.every(isNum))
      throw new Error('paintStroke: points must be groups of x, y, pressure (…) values');
    const color = p['color'];
    if (!Array.isArray(color) || color.length !== ctx.doc.colorChannels || !color.every(isNum))
      throw new Error('paintStroke: color needs one value per colour channel');
    const seed = p['seed'] ?? 0;
    if (!Number.isInteger(seed)) throw new Error('paintStroke: seed must be a whole number');
    const raw = p['colors'] as { foreground?: unknown; background?: unknown } | undefined;
    const colors =
      raw === undefined
        ? undefined
        : { foreground: parseRgb(raw.foreground, 'foreground'), background: parseRgb(raw.background, 'background') };
    const symmetry = p['symmetry'] === undefined || p['symmetry'] === null ? undefined : parseSymmetry(p['symmetry']);
    return new PaintStrokeCommand(ctx, {
      tool,
      points,
      stride,
      brush: parseBrush(p['brush']),
      color,
      seed: seed as number,
      ...(colors ? { colors } : {}),
      ...(symmetry ? { symmetry } : {}),
    });
  },
};
