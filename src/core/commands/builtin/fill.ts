/**
 * Edit > Fill (Shift+F5, Shift+Backspace) and the quick fills (Alt+Backspace:
 * foreground colour, Ctrl/Cmd+Backspace: background colour; with Shift, keeping
 * transparency).
 *
 * Behaviour (own summary of the reference app): fills the selection — or the whole
 * canvas area of the active layer — with a colour, a pattern (repeated from the
 * document's top left corner) or History (the layer as it was in the History Brush
 * source state), blended with a mode and opacity. Preserve Transparency changes only
 * existing pixels; it is not offered on the Background, which has no transparency.
 */
import { LAYER_BLEND_MODES, layerCapabilities, type LayerBlendMode, type PixelLayer } from '../../document/layers';
import type { Tile } from '../../document/tile';
import type { FillSpec } from '../../paint/fill';
import { builtInPattern, patternSamples } from '../../pattern/pattern';
import { sourcePixels, sourceTilesFor } from '../../history/history-source';
import { Selection } from '../../selection/selection';
import { CommandUnavailableError, type Command, type CommandContext, type JsonObject } from '../command';
import { canvasLayerTiles, selectedLayerTiles } from '../pixel-targets';
import type { CommandDefinition } from '../registry';
import { LayerTileDiff } from '../tile-diff';

function target(ctx: CommandContext): PixelLayer | undefined {
  const layer = ctx.doc.activeLayer;
  return layer?.kind === 'pixel' && layerCapabilities(layer).editPixels ? layer : undefined;
}

/** What the fill descriptor records: a pattern by its id; `history` for History contents. */
type FillParams = Omit<FillSpec, 'pattern' | 'history'> & { pattern?: string; history?: true };

class FillCommand implements Command {
  readonly label = 'Fill';
  readonly descriptor: { name: string; params: JsonObject };
  readonly #ctx: CommandContext;
  readonly #spec: FillParams;
  #diff: LayerTileDiff | undefined;

  constructor(ctx: CommandContext, spec: FillParams) {
    this.#ctx = ctx;
    this.#spec = spec;
    this.descriptor = { name: 'fill', params: spec };
  }

  get undoBytes(): number {
    return this.#diff?.bytes ?? 0;
  }

  async execute(): Promise<void> {
    const { doc, services } = this.#ctx;
    const layer = target(this.#ctx);
    if (!layer) throw new CommandUnavailableError('Fill needs an editable pixel layer');
    const { pattern: patternId, history, ...rest } = this.#spec;
    let spec: FillSpec = rest;
    const source = history ? await this.#source(layer) : null;
    if (patternId !== undefined) {
      const pattern = services.patterns?.get(patternId) ?? builtInPattern(patternId);
      if (!pattern) throw new CommandUnavailableError('The pattern of this fill is not in the pattern library');
      spec = {
        ...rest,
        pattern: { width: pattern.width, height: pattern.height, data: patternSamples(pattern, doc.mode, doc.depth) },
      };
    } else if (!source && rest.color.length !== doc.colorChannels)
      throw new Error('fill: color needs one value per colour channel');
    // The selected part of the canvas (or all of it) — also where the layer has no tiles yet.
    const selection = doc.selection ?? Selection.all();
    const { coords, through } = selectedLayerTiles(doc, layer, selection, canvasLayerTiles(doc, layer));
    if (source)
      spec = { ...spec, history: sourcePixels(source, sourceTilesFor(source, coords, layer.offsetX, layer.offsetY)) };
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

  /** The History Brush source's version of the layer (History contents). */
  #source(layer: PixelLayer): Promise<PixelLayer> {
    const history = this.#ctx.history;
    if (!history) throw new CommandUnavailableError('There is no history to fill from');
    return history.sourceLayer(layer.id);
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

export const fillCommand: CommandDefinition = {
  name: 'fill',
  isAvailable: (ctx) => target(ctx) !== undefined,
  create: (ctx, p) => {
    const pattern = p['pattern'];
    if (pattern !== undefined && typeof pattern !== 'string') throw new Error('fill: pattern must be a pattern id');
    const history = p['history'] === true;
    if (history && pattern !== undefined) throw new Error('fill: History contents take no pattern');
    const raw = p['color'] ?? (pattern !== undefined || history ? [] : undefined);
    if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'number' && Number.isFinite(v)))
      throw new Error('fill: color must be a list of numbers');
    const color = raw as number[];
    const mode = p['mode'] ?? 'normal';
    if (!(LAYER_BLEND_MODES as readonly unknown[]).includes(mode)) throw new Error('fill: mode is not a blend mode');
    const opacity = p['opacity'] ?? 1;
    if (typeof opacity !== 'number' || !(opacity >= 0 && opacity <= 1)) throw new Error('fill: opacity must be 0–1');
    const preserve = p['preserveTransparency'] ?? false;
    if (typeof preserve !== 'boolean') throw new Error('fill: preserveTransparency must be true or false');
    return new FillCommand(ctx, {
      color,
      mode: mode as LayerBlendMode,
      opacity,
      preserveTransparency: preserve,
      ...(pattern !== undefined ? { pattern } : {}),
      ...(history ? { history: true as const } : {}),
    });
  },
};
