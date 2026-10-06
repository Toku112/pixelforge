/**
 * Image > Adjustments > Invert (Ctrl/Cmd+I).
 *
 * Behaviour (own summary of the reference app): every colour channel value v of the
 * target layer becomes (maximum − v), turning the image into its negative; layer
 * transparency is left untouched. There are no options, so the action descriptor
 * has no parameters and a replay applies to whichever layer is active.
 *
 * Availability: 8- and 16-bit RGB, CMYK and Grayscale documents with an editable
 * pixel layer active. Greyed out in 32-bit documents, where the reference app does not
 * offer it. Lab, Indexed, Bitmap, Duotone and Multichannel behaviour will be verified
 * and enabled with the adjustments work (Phase 4), together with selections,
 * mask/channel targets and the Invert adjustment layer.
 */
import { layerCapabilities, type PixelLayer } from '../../document/layers';
import { CommandUnavailableError, type Command, type CommandContext } from '../command';
import { wholeLayerTiles } from '../pixel-targets';
import type { CommandDefinition } from '../registry';
import { LayerTileDiff } from '../tile-diff';

const SUPPORTED_MODES = new Set(['rgb', 'cmyk', 'grayscale']);

function target(ctx: CommandContext): PixelLayer | undefined {
  const { doc } = ctx;
  if (doc.depth === 32 || !SUPPORTED_MODES.has(doc.mode)) return undefined;
  const layer = doc.activeLayer;
  if (!layer || layer.kind !== 'pixel' || !layerCapabilities(layer).editPixels) return undefined;
  return layer;
}

class InvertCommand implements Command {
  readonly label = 'Invert';
  readonly descriptor = { name: 'invert', params: {} };
  readonly #ctx: CommandContext;
  #diff: LayerTileDiff | undefined;

  constructor(ctx: CommandContext) {
    this.#ctx = ctx;
  }

  get undoBytes(): number {
    return this.#diff?.bytes ?? 0;
  }

  async execute(): Promise<void> {
    const { doc, services } = this.#ctx;
    const layer = target(this.#ctx);
    if (!layer) {
      throw new CommandUnavailableError(
        'Invert needs an editable pixel layer in an 8- or 16-bit RGB, CMYK or Grayscale document',
      );
    }
    const coords = wholeLayerTiles(doc, layer);
    const diff = new LayerTileDiff(layer.id);
    for (const [tx, ty] of coords) diff.captureBefore(doc, tx, ty);
    const tiles = coords.map(([tx, ty]) => layer.buffer.writableTile(tx, ty).data);
    try {
      await services.pixelOps.invert(tiles, layer.buffer.format);
    } catch (error) {
      diff.undo(doc);
      throw error;
    }
    // The worker wrote after the tiles were handed out: report them changed again.
    for (const [tx, ty] of coords) layer.buffer.markChanged(tx, ty);
    diff.captureAfter(doc);
    this.#diff = diff;
  }

  undo(): void {
    this.#diff?.undo(this.#ctx.doc);
  }

  redo(): void {
    this.#diff?.redo(this.#ctx.doc);
  }
}

export const invertCommand: CommandDefinition = {
  name: 'invert',
  isAvailable: (ctx) => target(ctx) !== undefined,
  create: (ctx) => new InvertCommand(ctx),
};
