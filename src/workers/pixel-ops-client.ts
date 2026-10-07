/**
 * The app's implementation of the core `PixelOps` service: runs operations in the
 * pixel worker (WebAssembly, multi-threaded when available).
 *
 * Tiles backed by SharedArrayBuffer are processed in place with no copying. Other
 * tiles are sent as copies and the results are written back into the original
 * arrays, so callers always see the change in the arrays they passed.
 */
import type { PixelOps } from '../core/commands/command';
import { copySamples, samplesPerPixel, type SampleArray } from '../core/document/pixel-format';
import type { PixelWorkerClient } from './pixel-client';

export function createWorkerPixelOps(worker: PixelWorkerClient): PixelOps {
  return {
    async invert(tiles: SampleArray[], format) {
      if (format.depth === 32) throw new Error('Invert is not available for 32-bit data');
      if (tiles.length === 0) return;
      const results = await worker.invertTiles(
        tiles as (Uint8Array | Uint16Array)[],
        samplesPerPixel(format),
        format.hasAlpha,
      );
      results.forEach((result, i) => {
        if (result) copySamples(tiles[i]!, result);
      });
    },
    convertAlpha(tiles, from, to, matte) {
      return worker.convertAlpha(tiles, from, to, [...matte]);
    },
  };
}
