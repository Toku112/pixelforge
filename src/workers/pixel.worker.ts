/**
 * Pixel worker: runs heavy pixel operations in WebAssembly off the main thread.
 *
 * When the page is cross-origin isolated (COOP/COEP headers), it loads the
 * multi-threaded SIMD build and starts a rayon thread pool (one Web Worker per
 * core); otherwise — or when started as "pixel-single-thread" — it uses the
 * single-threaded SIMD build.
 */
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
    if (data instanceof Uint8Array) ops.invertU8(data, channels, hasAlpha);
    else ops.invertU16(data, channels, hasAlpha);
    return transfer(data, [data.buffer]);
  },
};

export type PixelWorkerApi = typeof api;

exposeApi(api);
