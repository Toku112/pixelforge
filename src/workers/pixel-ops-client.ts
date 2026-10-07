/**
 * The app's implementation of the core `PixelOps` service: runs operations in the
 * pixel worker (WebAssembly, multi-threaded when available).
 *
 * Tiles backed by SharedArrayBuffer are processed in place with no copying. Other
 * tiles are sent as copies and the results are written back into the original
 * arrays, so callers always see the change in the arrays they passed.
 */
import { CommandCancelledError, type PixelOps } from '../core/commands/command';
import type { CompositeTile } from '../core/composite/composite-tiles';
import { TILE_SIZE, tileIndex } from '../core/document/tile';
import { copySamples, samplesPerPixel, type SampleArray } from '../core/document/pixel-format';
import type { PixelWorkerClient } from './pixel-client';

export function createWorkerPixelOps(worker: PixelWorkerClient): PixelOps {
  return {
    async invert(tiles: SampleArray[], format, through) {
      if (format.depth === 32) throw new Error('Invert is not available for 32-bit data');
      if (tiles.length === 0) return;
      if (through) {
        copyBack(tiles, await worker.invertTilesMasked(tiles, format, through));
        return;
      }
      const results = await worker.invertTiles(
        tiles as (Uint8Array | Uint16Array)[],
        samplesPerPixel(format),
        format.hasAlpha,
      );
      results.forEach((result, i) => {
        if (result) copySamples(tiles[i]!, result);
      });
    },
    async clear(tiles, format, through, fill) {
      if (tiles.length === 0) return;
      copyBack(tiles, await worker.clearTiles(tiles, format, through, fill ? [...fill] : null));
    },
    selectShape(current, shape, mode, feather, antiAlias, canvas) {
      return worker.selectShape(current, shape, mode, feather, antiAlias, canvas);
    },
    invertSelection(current, canvas) {
      return worker.invertSelection(current, canvas);
    },
    async movePixels(setup, sources, outputs) {
      if (outputs.length === 0) return;
      copyBack(
        outputs.map((o) => o.data),
        await worker.movePixels(setup, sources, outputs),
      );
    },
    async fill(tiles, format, through, spec, hdr) {
      if (tiles.length === 0) return;
      copyBack(tiles, await worker.fillTiles(tiles, format, through, spec, hdr));
    },
    async paintStroke(setup, tiles, coords, dabs) {
      if (tiles.length === 0) return;
      copyBack(tiles, await worker.paintStroke(setup, tiles, coords, dabs));
    },
    convertAlpha(tiles, from, to, matte) {
      return worker.convertAlpha(tiles, from, to, [...matte]);
    },
    async composite(plan, rect, format, matte, task) {
      // In bands of tile rows, so progress can be shown and Esc can stop between bands.
      const tiles: CompositeTile[] = [];
      const first = tileIndex(rect.y);
      const last = tileIndex(rect.y + rect.h - 1);
      for (let ty = first; ty <= last; ty++) {
        if (task?.cancelled) throw new CommandCancelledError();
        const top = Math.max(rect.y, ty * TILE_SIZE);
        const band = { x: rect.x, y: top, w: rect.w, h: Math.min(rect.y + rect.h, (ty + 1) * TILE_SIZE) - top };
        tiles.push(...(await worker.composite(plan, band, format, matte ? [...matte] : null)));
        task?.progress((ty - first + 1) / (last - first + 1));
      }
      if (task?.cancelled) throw new CommandCancelledError();
      return tiles;
    },
  };
}

/** Copies worker results into the caller's arrays (shared-memory tiles came back as null: edited in place). */
function copyBack(tiles: SampleArray[], results: (SampleArray | null)[]): void {
  results.forEach((result, i) => {
    if (result) copySamples(tiles[i]!, result);
  });
}
