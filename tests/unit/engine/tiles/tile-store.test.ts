import { describe, expect, it } from 'vitest';
import { ImageDocument } from '../../../../src/core/document/document';
import type { Tile } from '../../../../src/core/document/tile';
import { TILE_PIXELS } from '../../../../src/core/document/tile';
import { History } from '../../../../src/core/history/history';
import {
  MemorySwapBackend,
  TileStore,
  defaultMemoryBudget,
  type SwapBackend,
} from '../../../../src/engine/tiles/tile-store';
import { createRegistry, referencePixelOps } from '../../core/helpers';

const RGBA8_TILE = TILE_PIXELS * 4;

function docWithStore(store: TileStore, width = 512, height = 256) {
  const doc = new ImageDocument({ width, height, memory: store });
  const bg = doc.createBackgroundLayer();
  doc.insertLayer(bg);
  doc.setActiveLayer(bg.id);
  return { doc, ctx: { doc, services: { pixelOps: referencePixelOps } }, registry: createRegistry() };
}

describe('TileStore', () => {
  it('computes the default budget as 60% of device memory', () => {
    expect(defaultMemoryBudget(8)).toBe(Math.floor(8 * 0.6 * 1024 ** 3));
    expect(defaultMemoryBudget()).toBe(Math.floor(4 * 0.6 * 1024 ** 3));
  });

  it('allocates shared or ordinary memory', () => {
    expect(new TileStore({ shared: true, swap: null }).allocate(16)).toBeInstanceOf(SharedArrayBuffer);
    expect(new TileStore({ shared: false, swap: null }).allocate(16)).toBeInstanceOf(ArrayBuffer);
  });

  it('accounts for the memory of every tile it allocates', () => {
    const store = new TileStore({ autoEnforce: false, swap: null });
    const { doc } = docWithStore(store);
    doc.background!.buffer.writableTile(0, 0);
    doc.background!.buffer.writableTile(1, 0);
    expect(store.stats).toMatchObject({ residentBytes: 2 * 256 * 256 * 3, residentTiles: 2, swappedTiles: 0 });
  });

  it('evicts only frozen tiles that no open document uses, and reloads them exactly', async () => {
    const swap = new MemorySwapBackend();
    const store = new TileStore({ budgetBytes: 0, swap, autoEnforce: false });
    const { doc } = docWithStore(store);
    const buffer = doc.background!.buffer;
    buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([1, 2, 3]));
    const v1 = buffer.captureTile(0, 0)!; // frozen, still in the document
    buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([4, 5, 6])); // copy-on-write: v1 now only held here

    await store.enforceBudget();
    expect(v1.resident).toBe(false);
    expect(buffer.getTile(0, 0)!.resident).toBe(true); // the live tile is never evicted
    expect(swap.size).toBe(1);
    expect(() => v1.data).toThrow('not in memory');

    await store.ensureResident([v1]);
    expect(v1.resident).toBe(true);
    expect([...v1.data.subarray(0, 3)]).toEqual([1, 2, 3]);
    expect(swap.size).toBe(0);
    expect(store.stats).toMatchObject({ evictions: 1, reloads: 1, swappedBytes: 0 });
  });

  it('keeps memory under budget, evicting the oldest tiles first', async () => {
    const store = new TileStore({
      budgetBytes: 3 * RGBA8_TILE,
      autoEnforce: false,
      shared: false,
      swap: new MemorySwapBackend(),
    });
    const doc = new ImageDocument({ width: 256, height: 256, memory: store });
    const layer = doc.createPixelLayer();
    doc.insertLayer(layer);
    const versions: Tile[] = [];
    for (let i = 0; i < 6; i++) {
      layer.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([i, i, i, 255]));
      versions.push(layer.buffer.captureTile(0, 0)!);
    }
    await store.enforceBudget();
    expect(store.stats.residentBytes).toBeLessThanOrEqual(0.9 * store.budgetBytes);
    expect(versions.map((t) => t.resident)).toEqual([false, false, false, false, true, true]);
  });

  it('does not release a tile that was put back into a document while being written', async () => {
    let finishWrite: () => void = () => {};
    const slowSwap: SwapBackend = {
      store: () => new Promise((r) => (finishWrite = () => r(1))),
      load: () => Promise.reject(new Error('unused')),
      free: () => {},
    };
    const store = new TileStore({ budgetBytes: 0, swap: slowSwap, autoEnforce: false });
    const { doc } = docWithStore(store);
    const buffer = doc.background!.buffer;
    buffer.writableTile(0, 0);
    const old = buffer.captureTile(0, 0)!;
    buffer.writableTile(0, 0); // old is now unattached → evictable
    const enforcing = store.enforceBudget();
    await Promise.resolve();
    buffer.setTile(0, 0, old); // e.g. undo puts it back
    finishWrite();
    await enforcing;
    expect(old.resident).toBe(true);
  });

  it('loads a tile once even when asked concurrently', async () => {
    const swap = new MemorySwapBackend();
    let loads = 0;
    const counting: SwapBackend = {
      store: (b) => swap.store(b),
      load: (h) => (loads++, swap.load(h)),
      free: (h) => swap.free(h),
    };
    const store = new TileStore({ budgetBytes: 0, swap: counting, autoEnforce: false });
    const { doc } = docWithStore(store);
    const buffer = doc.background!.buffer;
    buffer.writableTile(0, 0);
    const old = buffer.captureTile(0, 0)!;
    buffer.writableTile(0, 0);
    await store.enforceBudget();
    await Promise.all([store.ensureResident([old]), store.ensureResident([old, old])]);
    expect(loads).toBe(1);
  });

  it('never evicts without a scratch disk', async () => {
    const store = new TileStore({ budgetBytes: 0, swap: null, autoEnforce: false });
    const { doc } = docWithStore(store);
    const buffer = doc.background!.buffer;
    buffer.writableTile(0, 0);
    const old = buffer.captureTile(0, 0)!;
    buffer.writableTile(0, 0);
    await store.enforceBudget();
    expect(store.canEvict).toBe(false);
    expect(old.resident).toBe(true);
  });

  it('evicts automatically after allocations exceed the budget', async () => {
    const store = new TileStore({ budgetBytes: RGBA8_TILE, shared: false, swap: new MemorySwapBackend() });
    const doc = new ImageDocument({ width: 256, height: 256, memory: store });
    const layer = doc.createPixelLayer();
    doc.insertLayer(layer);
    const first = (layer.buffer.writableTile(0, 0), layer.buffer.captureTile(0, 0)!);
    layer.buffer.writableTile(0, 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(first.resident).toBe(false);
  });

  it('lets the history undo and redo through evicted tiles', async () => {
    const store = new TileStore({ budgetBytes: 0, autoEnforce: false, swap: new MemorySwapBackend() });
    const { doc, ctx, registry } = docWithStore(store);
    const history = new History(doc, { residency: store });
    const px = () => doc.background!.buffer.getPixel(300, 100)[0];
    for (let i = 0; i < 4; i++) {
      await history.execute(registry.create(ctx, { name: 'invert', params: {} }));
      await store.enforceBudget();
    }
    expect(store.stats.swappedTiles).toBeGreaterThan(0);
    expect(px()).toBe(255); // inverted 4 times
    await history.undo();
    expect(px()).toBe(0);
    await history.goTo(0);
    expect(px()).toBe(255);
    expect(doc.background!.buffer.tileCount).toBe(0);
    await history.goTo(3);
    expect(px()).toBe(0);
    expect(store.stats.reloads).toBeGreaterThan(0);
  });
});
