import type { CodecWorkerApi } from './codec.worker';
import { wrapWorker } from './rpc';

/** Starts a codec worker and returns its typed client. */
export function createCodecWorker() {
  const worker = new Worker(new URL('./codec.worker.ts', import.meta.url), { type: 'module', name: 'codec' });
  return wrapWorker<CodecWorkerApi>(worker);
}

export type CodecWorkerClient = ReturnType<typeof createCodecWorker>;
