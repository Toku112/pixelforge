/**
 * Edit > Clear (Delete / Backspace with a selection).
 *
 * Behaviour (own summary of the reference app): the selected pixels of the active
 * layer become transparent — partly, where the selection is feathered. On the
 * Background, or a layer whose transparent pixels are locked, they are filled
 * with the background colour instead.
 */
import { effectiveLocks, layerCapabilities, type PixelLayer } from '../../document/layers';
import type { Tile } from '../../document/tile';
import { CommandUnavailableError, type Command, type CommandContext, type JsonObject } from '../command';
import type { CommandDefinition } from '../registry';
import { LayerTileDiff } from '../tile-diff';
import { selectedLayerTiles } from '../pixel-targets';

function target(ctx: CommandContext): PixelLayer | undefined {
  const layer = ctx.doc.activeLayer;
  if (!ctx.doc.selection || layer?.kind !== 'pixel' || !layerCapabilities(layer).editPixels) return undefined;
  return layer;
}

class ClearCommand implements Command {
  readonly label = 'Clear';
  readonly descriptor: { name: string; params: JsonObject };
  readonly #ctx: CommandContext;
  readonly #color: readonly number[] | undefined;
  #diff: LayerTileDiff | undefined;

  constructor(ctx: CommandContext, color: readonly number[] | undefined) {
    this.#ctx = ctx;
    this.#color = color;
    this.descriptor = { name: 'clear', params: color ? { color: [...color] } : {} };
  }

  get undoBytes(): number {
    return this.#diff?.bytes ?? 0;
  }

  async execute(): Promise<void> {
    const { doc, services } = this.#ctx;
    const layer = target(this.#ctx);
    if (!layer) throw new CommandUnavailableError('Clear needs a selection and an editable pixel layer');
    const keepOpaque = !layer.buffer.format.hasAlpha || effectiveLocks(layer).transparency;
    const fill = keepOpaque ? (this.#color ?? doc.whitePixel()) : null;
    if (fill && fill.length !== doc.colorChannels) throw new Error('clear: color needs one value per colour channel');
    const { coords, through } = selectedLayerTiles(doc, layer, doc.selection!);
    const diff = new LayerTileDiff(layer.id);
    for (const [tx, ty] of coords) diff.captureBefore(doc, tx, ty);
    const tiles = coords.map(([tx, ty]) => layer.buffer.writableTile(tx, ty).data);
    try {
      await services.pixelOps.clear(tiles, layer.buffer.format, through, fill);
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

export const clearCommand: CommandDefinition = {
  name: 'clear',
  isAvailable: (ctx) => target(ctx) !== undefined,
  create: (ctx, p) => {
    const color = p['color'];
    if (color !== undefined && (!Array.isArray(color) || !color.every((v) => typeof v === 'number')))
      throw new Error('clear: color must be a list of numbers');
    return new ClearCommand(ctx, color);
  },
};
