/**
 * Pixel worker: runs heavy pixel operations in WebAssembly off the main thread.
 *
 * When the page is cross-origin isolated (COOP/COEP headers), it loads the
 * multi-threaded SIMD build and starts a rayon thread pool (one Web Worker per
 * core); otherwise — or when started as "pixel-single-thread" — it uses the
 * single-threaded SIMD build.
 */
import { convertAlphaTile } from '../core/commands/alpha';
import { compositeTiles, type CompositeTile } from '../core/composite/composite-tiles';
import { clearMasked, invertMasked, type MaskedTarget } from '../core/selection/masked-edits';
import {
  invertSelection,
  maskBounds,
  selectShape,
  type SelectionMode,
  type SelectionShape,
} from '../core/selection/mask-ops';
import type { LayerGeometry } from '../core/commands/builtin/geometry';
import { mapLayer, resampleLayer, type LayerSource, type LayerTile } from '../core/geometry/layer-geometry';
import type { Dab } from '../core/paint/brush';
import { fillTiles, type FillSpec } from '../core/paint/fill';
import { movePixels, type MovePixelsSetup } from '../core/paint/move-pixels';
import { StrokeRenderer, type StrokeSetup } from '../core/paint/stroke';
import { selectionOutline } from '../core/selection/outline';
import type { MaskData } from '../core/selection/selection';
import type { FlattenPlan } from '../core/composite/flatten';
import { renderThumbnail, type Thumbnail, type ThumbnailSource } from '../core/composite/thumbnail';
import type { Rect } from '../core/document/geometry';
import { createSampleArray, samplesPerPixel, type PixelFormat, type SampleArray } from '../core/document/pixel-format';
import { exposeApi, transfer } from './rpc';
import type * as PixelOpsSt from '../wasm/pkg/pixel-ops-st/pixel_ops.js';

/** The operations both builds share (the threaded build only adds pool internals). */
type Ops = Omit<typeof PixelOpsSt, 'default' | 'initSync'>;

export interface PixelWorkerInfo {
  variant: 'mt' | 'st';
  simd: boolean;
  threads: boolean;
  threadCount: number;
  crossOriginIsolated: boolean;
}

async function load(): Promise<{ ops: Ops; variant: 'mt' | 'st' }> {
  if (self.crossOriginIsolated && self.name !== 'pixel-single-thread') {
    const mt = await import('../wasm/pkg/pixel-ops-mt/pixel_ops.js');
    await mt.default();
    await mt.initThreadPool(Math.max(1, navigator.hardwareConcurrency || 1));
    return { ops: mt, variant: 'mt' };
  }
  const st = await import('../wasm/pkg/pixel-ops-st/pixel_ops.js');
  await st.default();
  return { ops: st, variant: 'st' };
}

const ready = load();

function invertOne(ops: Ops, data: Uint8Array | Uint16Array, channels: number, hasAlpha: boolean): void {
  if (data instanceof Uint8Array) ops.invertU8(data, channels, hasAlpha);
  else ops.invertU16(data, channels, hasAlpha);
}

const api = {
  async info(): Promise<PixelWorkerInfo> {
    const { ops, variant } = await ready;
    return {
      variant,
      simd: ops.simdEnabled(),
      threads: ops.threadsEnabled(),
      threadCount: ops.threadCount(),
      crossOriginIsolated: self.crossOriginIsolated,
    };
  },

  /** Inverts colour samples in place (alpha untouched) and returns the buffer. */
  async invert<T extends Uint8Array | Uint16Array>(data: T, channels: number, hasAlpha: boolean): Promise<T> {
    const { ops } = await ready;
    invertOne(ops, data, channels, hasAlpha);
    return transfer(data, [data.buffer]);
  },

  /**
   * Inverts a batch of tiles. Tiles in shared memory are modified in place and
   * `null` is returned for them; other tiles come back (transferred) for the caller
   * to copy into place.
   */
  async invertTiles(
    tiles: (Uint8Array | Uint16Array)[],
    channels: number,
    hasAlpha: boolean,
  ): Promise<((Uint8Array | Uint16Array) | null)[]> {
    const { ops } = await ready;
    const results: ((Uint8Array | Uint16Array) | null)[] = [];
    const transfers: ArrayBuffer[] = [];
    for (const tile of tiles) {
      invertOne(ops, tile, channels, hasAlpha);
      if (tile.buffer instanceof SharedArrayBuffer) {
        results.push(null);
      } else {
        results.push(tile);
        transfers.push(tile.buffer);
      }
    }
    return transfer(results, transfers);
  },
};

/** New tile arrays: shared memory when the page is cross-origin isolated. */
function newSamples(format: PixelFormat, length: number): SampleArray {
  const bytes = length * (format.depth === 8 ? 1 : format.depth === 16 ? 2 : 4);
  const shared = self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
  return createSampleArray(format.depth, length, shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
}

/** Tiles in shared memory were edited in place (null); others go back to be copied over. */
function returnUnshared(tiles: SampleArray[]): (SampleArray | null)[] {
  const results = tiles.map((t) => (t.buffer instanceof SharedArrayBuffer ? null : t));
  return transfer(
    results,
    results.filter((t): t is SampleArray => t !== null).map((t) => t.buffer as ArrayBuffer),
  );
}

/** Live strokes being painted, by id. */
const strokes = new Map<number, StrokeRenderer>();

function transferMask(mask: MaskData | null): MaskData | null {
  if (!mask) return null;
  return transfer(
    mask,
    mask.tiles.filter((t) => !(t.data.buffer instanceof SharedArrayBuffer)).map((t) => t.data.buffer as ArrayBuffer),
  );
}

const conversions = {
  /** See PixelOps.convertAlpha. */
  convertAlpha(tiles: SampleArray[], from: PixelFormat, to: PixelFormat, matte: number[]): SampleArray[] {
    const out = tiles.map((t) =>
      convertAlphaTile(t, from, to, matte, newSamples(to, (t.length / samplesPerPixel(from)) * samplesPerPixel(to))),
    );
    return transfer(
      out,
      out.filter((t) => !(t.buffer instanceof SharedArrayBuffer)).map((t) => t.buffer as ArrayBuffer),
    );
  },

  /** Selection-limited Invert; same return convention as invertTiles. */
  invertTilesMasked(tiles: SampleArray[], format: PixelFormat, through: MaskedTarget): (SampleArray | null)[] {
    invertMasked(tiles, format, through);
    return returnUnshared(tiles);
  },

  /** Edit > Clear through a selection; same return convention as invertTiles. */
  clearTiles(
    tiles: SampleArray[],
    format: PixelFormat,
    through: MaskedTarget,
    fill: number[] | null,
  ): (SampleArray | null)[] {
    clearMasked(tiles, format, through, fill);
    return returnUnshared(tiles);
  },

  /** See PixelOps.selectShape. */
  selectShape(
    current: MaskData | null,
    shape: SelectionShape,
    mode: SelectionMode,
    feather: number,
    antiAlias: boolean,
    canvas: Rect,
  ): MaskData | null {
    return transferMask(selectShape(current, shape, mode, feather, antiAlias, canvas));
  },

  /** See PixelOps.invertSelection. */
  invertSelection(current: MaskData, canvas: Rect): MaskData | null {
    return transferMask(invertSelection(current, canvas));
  },

  /** See PixelOps.composite. */
  composite(plan: FlattenPlan, rect: Rect, format: PixelFormat, matte: number[] | null): CompositeTile[] {
    const shared = self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
    const tiles = compositeTiles(plan, rect, format, matte, (n) =>
      shared ? new SharedArrayBuffer(n) : new ArrayBuffer(n),
    );
    return transfer(
      tiles,
      tiles.filter((t) => !(t.data.buffer instanceof SharedArrayBuffer)).map((t) => t.data.buffer as ArrayBuffer),
    );
  },

  /** See PixelOps.maskBounds. */
  maskBounds(mask: MaskData, canvas: Rect): Rect | null {
    return maskBounds(mask, canvas);
  },

  /** See PixelOps.transformLayer. */
  transformLayer(
    source: LayerSource,
    geometry: Exclude<LayerGeometry, { kind: 'offset' }>,
    fill: number[] | null,
  ): LayerTile[] {
    const shared = self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
    const allocate = (n: number) => (shared ? new SharedArrayBuffer(n) : new ArrayBuffer(n));
    const tiles =
      geometry.kind === 'map'
        ? mapLayer(source, geometry.map, geometry.clip, fill, allocate)
        : resampleLayer(source, geometry.scaleX, geometry.scaleY, geometry.method, geometry.clip, fill, allocate);
    return transfer(
      tiles,
      tiles.filter((t) => !(t.data.buffer instanceof SharedArrayBuffer)).map((t) => t.data.buffer as ArrayBuffer),
    );
  },

  /** See PixelOps.movePixels: edited outputs not in shared memory come back (by index), the rest are null. */
  movePixels(
    setup: MovePixelsSetup,
    sources: { tx: number; ty: number; data: SampleArray }[],
    outputs: { tx: number; ty: number; data: SampleArray }[],
  ): (SampleArray | null)[] {
    movePixels(setup, sources, outputs);
    return returnUnshared(outputs.map((o) => o.data));
  },

  /** See PixelOps.fill; same return convention as invertTiles. */
  fillTiles(
    tiles: SampleArray[],
    format: PixelFormat,
    through: MaskedTarget,
    spec: FillSpec,
    hdr: boolean,
  ): (SampleArray | null)[] {
    fillTiles(tiles, format, through, spec, hdr);
    return returnUnshared(tiles);
  },

  /** See PixelOps.paintStroke (a whole recorded stroke at once); same return convention as invertTiles. */
  paintStroke(
    setup: StrokeSetup,
    tiles: SampleArray[],
    coords: [number, number][],
    dabs: Dab[],
  ): (SampleArray | null)[] {
    const renderer = new StrokeRenderer(setup);
    tiles.forEach((data, i) => renderer.addTile(coords[i]![0], coords[i]![1], data));
    renderer.applyDabs(dabs);
    return returnUnshared(tiles);
  },

  /** Starts a live stroke (the Brush or Eraser being dragged). */
  strokeBegin(id: number, setup: StrokeSetup): void {
    strokes.set(id, new StrokeRenderer(setup));
  },

  /**
   * Paints a batch of dabs of a live stroke into its tiles (`tiles`: tiles touched
   * for the first time). Tiles in shared memory change in place; edited copies of
   * the others are returned for the caller to copy over.
   */
  strokeDabs(id: number, tiles: { tx: number; ty: number; data: SampleArray }[], dabs: Dab[]) {
    const renderer = strokes.get(id);
    if (!renderer) throw new Error(`No stroke ${id}`);
    for (const t of tiles) renderer.addTile(t.tx, t.ty, t.data);
    const edited: { tx: number; ty: number; data: SampleArray }[] = [];
    for (const key of renderer.applyDabs(dabs)) {
      const tile = renderer.tile(key)!;
      if (!(tile.data.buffer instanceof SharedArrayBuffer)) edited.push({ ...tile, data: tile.data.slice() });
    }
    return transfer(
      edited,
      edited.map((t) => t.data.buffer as ArrayBuffer),
    );
  },

  strokeEnd(id: number): void {
    strokes.delete(id);
  },

  /** Marching-ants outline of a selection (see core/selection/outline.ts). */
  selectionOutline(mask: MaskData, canvas: Rect): Float32Array[] {
    const loops = selectionOutline(mask, canvas);
    return transfer(
      loops,
      loops.map((l) => l.buffer as ArrayBuffer),
    );
  },

  /** A Layers-panel thumbnail of one layer over `area` (see core/composite/thumbnail.ts). */
  layerThumbnail(source: ThumbnailSource, area: Rect, width: number, height: number): Thumbnail {
    const thumbnail = renderThumbnail(source, area, width, height);
    return transfer(thumbnail, [thumbnail.data.buffer as ArrayBuffer]);
  },
};
Object.assign(api, conversions);

export type PixelWorkerApi = typeof api & typeof conversions;

exposeApi(api);
