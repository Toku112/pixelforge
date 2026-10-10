/**
 * Live brush/eraser strokes in the pixel worker (see core/paint/stroke.ts).
 *
 * Tiles in shared memory are painted in place by the worker; otherwise the worker
 * paints its own copies and sends the edited tiles back, which are copied into the
 * layer's arrays here.
 */
import type { Dab } from '../core/paint/brush';
import type { StrokeSetup } from '../core/paint/stroke';
import type { MixerEnd } from '../core/paint/mixer';
import { copySamples, type SampleArray } from '../core/document/pixel-format';
import { tileKey } from '../core/document/tile';
import type { PixelWorkerClient } from './pixel-client';

export interface LiveStroke {
  /**
   * Paints dabs; `tiles` are layer tiles touched for the first time (written in place),
   * `sources` the History Brush source tiles they need (strokes with a history source).
   */
  paint(
    tiles: { tx: number; ty: number; data: SampleArray }[],
    dabs: Dab[],
    sources?: { tx: number; ty: number; data: SampleArray }[],
  ): Promise<void>;
  /** Mixer Brush strokes: what the brush holds after the dabs painted so far (null for other strokes). */
  mixerEnd(): Promise<MixerEnd | null>;
  /** Frees the worker's state for the stroke. */
  end(): void;
}

export interface StrokeEngine {
  begin(setup: StrokeSetup): LiveStroke;
}

export function createStrokeEngine(worker: PixelWorkerClient): StrokeEngine {
  let nextId = 1;
  return {
    begin(setup) {
      const id = nextId++;
      const started = worker.strokeBegin(id, setup);
      const arrays = new Map<number, SampleArray>();
      return {
        async paint(tiles, dabs, sources = []) {
          await started;
          for (const t of tiles) arrays.set(tileKey(t.tx, t.ty), t.data);
          const edited = await worker.strokeDabs(id, tiles, dabs, sources);
          for (const e of edited) copySamples(arrays.get(tileKey(e.tx, e.ty))!, e.data);
        },
        async mixerEnd() {
          await started;
          return worker.strokeMixerEnd(id);
        },
        end() {
          void worker.strokeEnd(id);
        },
      };
    },
  };
}

/** A live stroke that begins in the worker once `started` settles (e.g. when its brush is ready). */
export function deferredStroke(started: Promise<LiveStroke>): LiveStroke {
  return {
    async paint(tiles, dabs, sources) {
      return (await started).paint(tiles, dabs, sources);
    },
    async mixerEnd() {
      return (await started).mixerEnd();
    },
    end() {
      void started.then(
        (live) => live.end(),
        () => undefined,
      );
    },
  };
}
