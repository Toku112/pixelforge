import type { ImageDocument } from '../document/document';
import { intersectRects, isEmptyRect } from '../document/geometry';
import type { PixelLayer } from '../document/layers';
import { TILE_SIZE, tileIndex, tileKey } from '../document/tile';
import type { MaskedTarget } from '../selection/masked-edits';
import type { Selection } from '../selection/selection';

/**
 * Tiles a whole-layer pixel operation must process, as [tx, ty] in layer tile space:
 * every allocated tile, plus — when unallocated tiles are visible (Background layers,
 * or any non-transparent default pixel) — every tile covering the canvas.
 */
export function wholeLayerTiles(doc: ImageDocument, layer: PixelLayer): [number, number][] {
  const buffer = layer.buffer;
  const coords = new Map<number, [number, number]>();
  for (const [tx, ty] of buffer.tiles()) coords.set(tileKey(tx, ty), [tx, ty]);

  const alphaIndex = buffer.format.colorChannels;
  const defaultVisible = !buffer.format.hasAlpha || buffer.defaultPixel[alphaIndex] !== 0;
  if (defaultVisible) {
    const x0 = -layer.offsetX;
    const y0 = -layer.offsetY;
    for (let ty = tileIndex(y0); ty <= tileIndex(y0 + doc.height - 1); ty++) {
      for (let tx = tileIndex(x0); tx <= tileIndex(x0 + doc.width - 1); tx++) {
        coords.set(tileKey(tx, ty), [tx, ty]);
      }
    }
  }
  return [...coords.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/**
 * The layer tiles a selection-limited edit touches (those of `wholeLayerTiles`
 * meeting the selection's bounds), with the selection data for the worker.
 */
export function selectedLayerTiles(
  doc: ImageDocument,
  layer: PixelLayer,
  selection: Selection,
): { coords: [number, number][]; through: MaskedTarget } {
  const bounds = selection.bounds(doc.canvasRect);
  const coords = wholeLayerTiles(doc, layer).filter(
    ([tx, ty]) =>
      !isEmptyRect(
        intersectRects(bounds, {
          x: tx * TILE_SIZE + layer.offsetX,
          y: ty * TILE_SIZE + layer.offsetY,
          w: TILE_SIZE,
          h: TILE_SIZE,
        }),
      ),
  );
  return {
    coords,
    through: { mask: selection.data, canvas: doc.canvasRect, offsetX: layer.offsetX, offsetY: layer.offsetY, coords },
  };
}
