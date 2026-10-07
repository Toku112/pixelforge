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

  /** A Layers-panel thumbnail of one layer over `area` (see core/composite/thumbnail.ts). */
  layerThumbnail(source: ThumbnailSource, area: Rect, width: number, height: number): Thumbnail {
    const thumbnail = renderThumbnail(source, area, width, height);
    return transfer(thumbnail, [thumbnail.data.buffer as ArrayBuffer]);
  },
};
Object.assign(api, conversions);

export type PixelWorkerApi = typeof api & typeof conversions;

exposeApi(api);
