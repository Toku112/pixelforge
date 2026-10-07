/**
 * Moving the selected pixels of the active layer (Move tool with a selection, and
 * the arrow keys then); with `copy` (Alt-drag) the original stays. The selection
 * moves with them. One History step, "Move" (or "Nudge" for the arrow keys).
 */
import { intersectRects, isEmptyRect, translateRect, unionRects, type Rect } from '../../document/geometry';
import { effectiveLocks, layerCapabilities, type PixelLayer } from '../../document/layers';
import { tileIndex, tileKey, type Tile } from '../../document/tile';
import type { SampleArray } from '../../document/pixel-format';
import type { Selection } from '../../selection/selection';
import { CommandUnavailableError, type Command, type CommandContext, type JsonObject } from '../command';
import type { CommandDefinition } from '../registry';
import { LayerTileDiff } from '../tile-diff';

function target(ctx: CommandContext): PixelLayer | undefined {
  const layer = ctx.doc.activeLayer;
  if (!ctx.doc.selection || layer?.kind !== 'pixel' || !layerCapabilities(layer).editPixels) return undefined;
  return layer;
}

/** Layer tiles (layer tile coordinates) covering a document rectangle. */
function tilesOf(r: Rect, layer: PixelLayer): [number, number][] {
  if (isEmptyRect(r)) return [];
  const out: [number, number][] = [];
  const x0 = r.x - layer.offsetX;
  const y0 = r.y - layer.offsetY;
  for (let ty = tileIndex(y0); ty <= tileIndex(y0 + r.h - 1); ty++)
    for (let tx = tileIndex(x0); tx <= tileIndex(x0 + r.w - 1); tx++) out.push([tx, ty]);
  return out;
}

class MoveSelectedPixelsCommand implements Command {
  readonly label: string;
  readonly descriptor: { name: string; params: JsonObject };
  readonly #ctx: CommandContext;
  readonly #dx: number;
  readonly #dy: number;
  readonly #color: readonly number[] | undefined;
  #diff: LayerTileDiff | undefined;
  #selections: { before: Selection; after: Selection } | undefined;

  readonly #copy: boolean;

  constructor(
    ctx: CommandContext,
    dx: number,
    dy: number,
    nudge: boolean,
    copy: boolean,
    color: readonly number[] | undefined,
  ) {
    this.#ctx = ctx;
    this.#dx = dx;
    this.#dy = dy;
    this.#copy = copy;
    this.#color = color;
    this.label = nudge ? 'Nudge' : 'Move';
    const params: JsonObject = { dx, dy };
    if (nudge) params['nudge'] = true;
    if (copy) params['copy'] = true;
    if (color) params['color'] = [...color];
    this.descriptor = { name: 'moveSelectedPixels', params };
  }

  get undoBytes(): number {
    return this.#diff?.bytes ?? 0;
  }

  async execute(): Promise<void> {
    const { doc, services } = this.#ctx;
    const layer = target(this.#ctx);
    if (!layer) throw new CommandUnavailableError('Moving pixels needs a selection and an editable pixel layer');
    const selection = doc.selection!;
    const opaque = !layer.buffer.format.hasAlpha || effectiveLocks(layer).transparency;
    const fill = opaque ? [...(this.#color ?? doc.whitePixel())] : null;
    const from = selection.bounds(doc.canvasRect);
    let to = translateRect(from, this.#dx, this.#dy);
    // Layers without alpha (the Background) cannot hold pixels outside the canvas.
    if (!layer.buffer.format.hasAlpha) to = intersectRects(to, doc.canvasRect);
    const outputs = tilesOf(unionRects(from, to), layer);
    const sourceKeys = new Map<number, [number, number]>();
    for (const c of [...outputs, ...tilesOf(from, layer)]) sourceKeys.set(tileKey(c[0], c[1]), c);

    const diff = new LayerTileDiff(layer.id);
    for (const [tx, ty] of outputs) diff.captureBefore(doc, tx, ty);
    // Unchanging copies to read from (captured tiles are frozen), then writable outputs.
    const sources: { tx: number; ty: number; data: SampleArray }[] = [];
    for (const [tx, ty] of sourceKeys.values()) {
      const tile: Tile | undefined = layer.buffer.captureTile(tx, ty);
      if (tile) sources.push({ tx, ty, data: tile.data });
    }
    const outTiles = outputs.map(([tx, ty]) => ({ tx, ty, data: layer.buffer.writableTile(tx, ty).data }));
    try {
      await services.pixelOps.movePixels(
        {
          format: layer.buffer.format,
          defaultPixel: layer.buffer.defaultPixel,
          mask: selection.data,
          canvas: doc.canvasRect,
          offsetX: layer.offsetX,
          offsetY: layer.offsetY,
          dx: this.#dx,
          dy: this.#dy,
          fill,
          keep: this.#copy,
        },
        sources,
        outTiles,
      );
    } catch (error) {
      diff.undo(doc);
      throw error;
    }
    for (const [tx, ty] of outputs) layer.buffer.markChanged(tx, ty);
    diff.captureAfter(doc);
    this.#diff = diff;
    this.#selections = { before: selection, after: selection.moved(this.#dx, this.#dy) };
    doc.setSelection(this.#selections.after);
  }

  retainedTiles(): Iterable<Tile> {
    return this.#diff?.tiles() ?? [];
  }

  undo(): void {
    this.#diff?.undo(this.#ctx.doc);
    if (this.#selections) this.#ctx.doc.setSelection(this.#selections.before);
  }

  redo(): void {
    this.#diff?.redo(this.#ctx.doc);
    if (this.#selections) this.#ctx.doc.setSelection(this.#selections.after);
  }
}

export const moveSelectedPixelsCommand: CommandDefinition = {
  name: 'moveSelectedPixels',
  isAvailable: (ctx) => target(ctx) !== undefined,
  create: (ctx, p) => {
    const { dx, dy } = p;
    if (!Number.isInteger(dx) || !Number.isInteger(dy))
      throw new Error('moveSelectedPixels: dx and dy must be whole pixels');
    const color = p['color'];
    if (color !== undefined && (!Array.isArray(color) || !color.every((v) => typeof v === 'number')))
      throw new Error('moveSelectedPixels: color must be a list of numbers');
    return new MoveSelectedPixelsCommand(
      ctx,
      dx as number,
      dy as number,
      p['nudge'] === true,
      p['copy'] === true,
      color === undefined ? undefined : color,
    );
  },
};
