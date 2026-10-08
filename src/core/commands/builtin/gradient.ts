/**
 * The Gradient tool's fill (History: "Gradient"): a gradient laid out from a start
 * to an end point across the selection — or the whole canvas area of the active
 * layer — blended with a mode and opacity. Layers with locked transparency (and the
 * Background) keep their alpha.
 *
 * The descriptor holds the gradient with its foreground/background stops already
 * given their colours, so a replay paints the same colours.
 */
import {
  LAYER_BLEND_MODES,
  effectiveLocks,
  layerCapabilities,
  type LayerBlendMode,
  type PixelLayer,
} from '../../document/layers';
import type { Tile } from '../../document/tile';
import {
  GRADIENT_METHODS,
  GRADIENT_SHAPES,
  gradientSamples,
  gradientTable,
  parseGradient,
  type Gradient,
  type GradientMethod,
  type GradientShape,
} from '../../paint/gradient';
import { Selection } from '../../selection/selection';
import {
  CommandCancelledError,
  CommandUnavailableError,
  type Command,
  type CommandContext,
  type JsonObject,
} from '../command';
import { canvasLayerTiles, selectedLayerTiles } from '../pixel-targets';
import type { CommandDefinition } from '../registry';
import { LayerTileDiff } from '../tile-diff';

export interface GradientParams {
  gradient: Gradient;
  method: GradientMethod;
  shape: GradientShape;
  /** Document coordinates. */
  start: { x: number; y: number };
  end: { x: number; y: number };
  reverse: boolean;
  dither: boolean;
  /** Use the gradient's opacity stops (otherwise opaque throughout). */
  transparency: boolean;
  /** A blend mode, or Behind / Clear (layers with editable transparency). */
  mode: LayerBlendMode | 'behind' | 'clear';
  /** 0–1. */
  opacity: number;
}

/** Layer tiles per worker call (about two million pixels). */
const CHUNK_TILES = 32;

function target(ctx: CommandContext): PixelLayer | undefined {
  const layer = ctx.doc.activeLayer;
  return layer?.kind === 'pixel' && layerCapabilities(layer).editPixels ? layer : undefined;
}

class GradientCommand implements Command {
  readonly label = 'Gradient';
  readonly descriptor: { name: string; params: JsonObject };
  readonly #ctx: CommandContext;
  readonly #params: GradientParams;
  #diff: LayerTileDiff | undefined;

  constructor(ctx: CommandContext, params: GradientParams) {
    this.#ctx = ctx;
    this.#params = params;
    this.descriptor = { name: 'gradient', params: params as unknown as JsonObject };
  }

  get undoBytes(): number {
    return this.#diff?.bytes ?? 0;
  }

  async execute(): Promise<void> {
    const { doc, services } = this.#ctx;
    const layer = target(this.#ctx);
    if (!layer) throw new CommandUnavailableError('The Gradient tool needs an editable pixel layer');
    const p = this.#params;
    const table = gradientSamples(gradientTable(p.gradient, p.method, p.transparency), doc.mode, doc.depth);
    const selection = doc.selection ?? Selection.all();
    const { coords, through } = selectedLayerTiles(doc, layer, selection, canvasLayerTiles(doc, layer));
    const diff = new LayerTileDiff(layer.id);
    for (const [tx, ty] of coords) diff.captureBefore(doc, tx, ty);
    const tiles = coords.map(([tx, ty]) => layer.buffer.writableTile(tx, ty).data);
    const spec = {
      table,
      geometry: { shape: p.shape, start: p.start, end: p.end, reverse: p.reverse },
      dither: p.dither,
      mode: p.mode,
      opacity: p.opacity,
      preserveTransparency: effectiveLocks(layer).transparency,
    };
    const task = this.#ctx.task;
    try {
      // In chunks, so progress shows and Esc can stop a large fill between them.
      for (let start = 0; start < tiles.length; start += CHUNK_TILES) {
        if (task?.cancelled) throw new CommandCancelledError();
        const part = coords.slice(start, start + CHUNK_TILES);
        await services.pixelOps.gradient(
          tiles.slice(start, start + CHUNK_TILES),
          layer.buffer.format,
          { ...through, coords: part },
          spec,
          doc.depth === 32,
        );
        task?.progress(Math.min(1, (start + CHUNK_TILES) / tiles.length));
      }
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

function point(v: unknown, name: string): { x: number; y: number } {
  const p = v as { x?: unknown; y?: unknown } | null;
  if (typeof p?.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y))
    throw new Error(`gradient: ${name} must be a point`);
  return { x: p.x, y: p.y };
}

function oneOf<T extends string>(v: unknown, options: readonly (readonly [T, string])[], fallback: T, name: string): T {
  if (v === undefined) return fallback;
  if (!options.some(([o]) => o === v)) throw new Error(`gradient: ${name} is not known`);
  return v as T;
}

function flag(v: unknown, fallback: boolean, name: string): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new Error(`gradient: ${name} must be true or false`);
  return v;
}

export const gradientCommand: CommandDefinition = {
  name: 'gradient',
  isAvailable: (ctx) => target(ctx) !== undefined,
  create: (ctx, p) => {
    const mode = p['mode'] ?? 'normal';
    if (!(LAYER_BLEND_MODES as readonly unknown[]).includes(mode) && mode !== 'behind' && mode !== 'clear')
      throw new Error('gradient: mode is not a blend mode');
    const opacity = p['opacity'] ?? 1;
    if (typeof opacity !== 'number' || !(opacity >= 0 && opacity <= 1))
      throw new Error('gradient: opacity must be 0–1');
    return new GradientCommand(ctx, {
      gradient: parseGradient(p['gradient']),
      method: oneOf(p['method'], GRADIENT_METHODS, 'perceptual', 'method'),
      shape: oneOf(p['shape'], GRADIENT_SHAPES, 'linear', 'shape'),
      start: point(p['start'], 'start'),
      end: point(p['end'], 'end'),
      reverse: flag(p['reverse'], false, 'reverse'),
      dither: flag(p['dither'], true, 'dither'),
      transparency: flag(p['transparency'], true, 'transparency'),
      mode: mode as GradientParams['mode'],
      opacity,
    });
  },
};
