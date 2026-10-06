// Test-only page (served by the dev server) exposing the pixel worker to Playwright.
import { createPixelWorker } from '../../../src/workers/pixel-client';
import { createWorkerPixelOps } from '../../../src/workers/pixel-ops-client';
import { transfer } from '../../../src/workers/rpc';

const workers = { mt: createPixelWorker(), st: createPixelWorker({ threads: false }) };
type Kind = keyof typeof workers;

const harness = {
  info: (kind: Kind = 'mt') => workers[kind].info(),
  /** Inverts `pixels` RGBA pixels of a deterministic pattern; returns timing and mismatch count. */
  async invertPattern(pixels: number, kind: Kind = 'mt') {
    const data = new Uint8Array(pixels * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) % 251;
    const t0 = performance.now();
    const out = await workers[kind].invert(transfer(data, [data.buffer]), 4, true);
    const ms = performance.now() - t0;
    let mismatches = 0;
    for (let i = 0; i < out.length; i++) {
      const original = (i * 31) % 251;
      const expected = i % 4 === 3 ? original : 255 - original;
      if (out[i] !== expected) mismatches++;
    }
    return { ms, mismatches, length: out.length };
  },

  /** Runs PixelOps.invert on one heap-backed and one shared-memory tile; returns their first pixels. */
  async pixelOpsInvert() {
    const pixelOps = createWorkerPixelOps(workers.mt);
    const heap = new Uint8Array(256 * 256 * 4).fill(10);
    const shared = new Uint8Array(new SharedArrayBuffer(256 * 256 * 4)).fill(20);
    await pixelOps.invert([heap, shared], { depth: 8, colorChannels: 3, hasAlpha: true });
    return { heap: [...heap.subarray(0, 4)], shared: [...shared.subarray(0, 4)], heapLength: heap.length };
  },
};

declare global {
  interface Window {
    __harness?: typeof harness;
  }
}
window.__harness = harness;
