/** Swap backend that stores evicted tiles on the OPFS scratch disk via the swap worker. */
import { wrapWorker, type Remote, type WrappedWorker } from '../../workers/rpc';
import type { SwapWorkerApi } from '../../workers/swap.worker';
import type { SwapBackend } from './tile-store';

export class OpfsSwapBackend implements SwapBackend {
  readonly #worker: Remote<SwapWorkerApi> & WrappedWorker;

  private constructor(worker: Remote<SwapWorkerApi> & WrappedWorker) {
    this.#worker = worker;
  }

  /**
   * Starts the scratch disk, or returns null when OPFS is unavailable (e.g. Safari
   * private windows); tiles then simply stay in memory.
   */
  static async create(): Promise<OpfsSwapBackend | null> {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return null;
    const worker = wrapWorker<SwapWorkerApi>(
      new Worker(new URL('../../workers/swap.worker.ts', import.meta.url), { type: 'module', name: 'swap' }),
    );
    try {
      await worker.stats(); // waits for the worker to open its OPFS folder
      return new OpfsSwapBackend(worker);
    } catch (error) {
      console.warn('Scratch disk unavailable; tiles will stay in memory.', error);
      worker.terminate();
      return null;
    }
  }

  store(bytes: Uint8Array): Promise<number> {
    // Shared-memory views are read by the worker directly; others are copied by postMessage.
    return this.#worker.store(bytes);
  }

  load(handle: number): Promise<Uint8Array> {
    return this.#worker.load(handle);
  }

  free(handle: number): void {
    void this.#worker.free(handle);
  }

  stats() {
    return this.#worker.stats();
  }

  async dispose(): Promise<void> {
    await this.#worker.dispose();
    this.#worker.terminate();
  }
}
