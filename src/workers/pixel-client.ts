import { wrapWorker } from './rpc';
import type { PixelWorkerApi } from './pixel.worker';

export interface PixelWorkerOptions {
  /** Use the multi-threaded build when the page allows it (default true). */
  threads?: boolean;
}

/** Starts a pixel worker and returns its typed client. */
export function createPixelWorker({ threads = true }: PixelWorkerOptions = {}) {
  // The worker reads its name to decide whether it may start a thread pool.
  const name = threads ? 'pixel' : 'pixel-single-thread';
  const worker = new Worker(new URL('./pixel.worker.ts', import.meta.url), { type: 'module', name });
  return wrapWorker<PixelWorkerApi>(worker);
}

export type PixelWorkerClient = ReturnType<typeof createPixelWorker>;
