/**
 * The History Brush source: a history state (or the initial snapshot) whose pixels
 * the History Brush, the Art History Brush, the Eraser's Erase to History and
 * Edit > Fill > History bring back.
 *
 * Painting from the source uses the source state's version of the layer being
 * painted (the layer with the same id). That is only possible when the state has
 * that layer and the canvas has the same size, colour mode and bit depth.
 */
import { CommandUnavailableError } from '../commands/command';
import type { ImageDocument } from '../document/document';
import type { LayerNode, PixelLayer } from '../document/layers';
import { TILE_SIZE, tileIndex, type Tile } from '../document/tile';
import type { PixelFormat, SampleArray } from '../document/pixel-format';
import type { DocumentState } from './snapshot';

/** Where commands find the source (the document's History). */
export interface HistorySource {
  /** The source state's copy of a layer, its tiles in memory; throws HistorySourceError when there is none. */
  sourceLayer(layerId: string): Promise<PixelLayer>;
}

/** The source state cannot be painted from onto this layer. */
export class HistorySourceError extends CommandUnavailableError {}

function findLayer(nodes: readonly LayerNode[], id: string): LayerNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === 'group') {
      const found = findLayer(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** The state's version of a layer of `doc`; throws HistorySourceError when it has none or the canvas differs. */
export function stateLayer(state: DocumentState, doc: ImageDocument, layerId: string): PixelLayer {
  const c = state.canvas;
  if (c.width !== doc.width || c.height !== doc.height || c.mode !== doc.mode || c.depth !== doc.depth)
    throw new HistorySourceError(
      'The canvas size, colour mode or bit depth is different in the history state chosen as the source. ' +
        'In the History panel, choose a state from after the last such change as the source.',
    );
  const layer = findLayer(state.layers, layerId);
  if (layer?.kind !== 'pixel')
    throw new HistorySourceError(
      'The history state chosen as the source does not have this layer. ' +
        'In the History panel, choose a state where the layer exists as the source.',
    );
  return layer;
}

/** Tiles of a source layer, with their layer tile coordinates. */
export interface SourceTile {
  tx: number;
  ty: number;
  data: SampleArray;
}

/** The source layer's pixels as the pixel worker reads them (document position = layer position + offset). */
export interface SourcePixels {
  /** The source layer's format: the layer's colour channels and depth; alpha may differ. */
  format: PixelFormat;
  defaultPixel: readonly number[];
  offsetX: number;
  offsetY: number;
  /** Source tiles (source layer tile coordinates); a stroke can be given more as it goes. */
  tiles: SourceTile[];
}

export function sourcePixels(source: PixelLayer, tiles: SourceTile[] = []): SourcePixels {
  return {
    format: source.buffer.format,
    defaultPixel: source.buffer.defaultPixel,
    offsetX: source.offsetX,
    offsetY: source.offsetY,
    tiles,
  };
}

/** Every tile a layer holds (for residency management). */
export function layerTiles(layer: PixelLayer): Tile[] {
  return [...layer.buffer.tiles()].map(([, , tile]) => tile);
}

/**
 * The source layer's tiles that cover the given tiles of a layer at (`offsetX`, `offsetY`)
 * (layer tile coordinates), skipping those in `known` (keys "tx,ty"), which this adds to.
 */
export function sourceTilesFor(
  source: PixelLayer,
  coords: readonly (readonly [number, number])[],
  offsetX: number,
  offsetY: number,
  known: Set<string> = new Set(),
): SourceTile[] {
  const out: SourceTile[] = [];
  const dx = offsetX - source.offsetX;
  const dy = offsetY - source.offsetY;
  for (const [tx, ty] of coords) {
    const x0 = tx * TILE_SIZE + dx;
    const y0 = ty * TILE_SIZE + dy;
    for (let sy = tileIndex(y0); sy <= tileIndex(y0 + TILE_SIZE - 1); sy++) {
      for (let sx = tileIndex(x0); sx <= tileIndex(x0 + TILE_SIZE - 1); sx++) {
        const key = `${sx},${sy}`;
        if (known.has(key)) continue;
        known.add(key);
        const tile = source.buffer.getTile(sx, sy);
        if (tile) out.push({ tx: sx, ty: sy, data: tile.data });
      }
    }
  }
  return out;
}
