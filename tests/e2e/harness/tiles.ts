// Test-only page: exercises the tile store with the real OPFS scratch disk.
import { registerBuiltinCommands } from '../../../src/core/commands/builtin';
import { CommandRegistry } from '../../../src/core/commands/registry';
import { ImageDocument } from '../../../src/core/document/document';
import { History } from '../../../src/core/history/history';
import { OpfsSwapBackend } from '../../../src/engine/tiles/opfs-swap';
import { TileStore } from '../../../src/engine/tiles/tile-store';
import { createPixelWorker } from '../../../src/workers/pixel-client';
import { createWorkerPixelOps } from '../../../src/workers/pixel-ops-client';

async function swapFolders(): Promise<string[]> {
  const root = await navigator.storage.getDirectory();
  const swap = await root.getDirectoryHandle('swap', { create: true });
  const names: string[] = [];
  for await (const name of swap.keys()) names.push(name);
  return names;
}

const harness = {
  /** Runs inverts under a tiny memory budget, then undoes and redoes through the scratch disk. */
  async undoThroughScratchDisk() {
    const swap = await OpfsSwapBackend.create();
    if (!swap) throw new Error('OPFS unavailable');
    const store = new TileStore({ budgetBytes: 1, swap, autoEnforce: false });
    const doc = new ImageDocument({ width: 1024, height: 1024, memory: store });
    const bg = doc.createBackgroundLayer();
    doc.insertLayer(bg);
    doc.setActiveLayer(bg.id);
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const ctx = { doc, services: { pixelOps: createWorkerPixelOps(createPixelWorker()) } };
    const history = new History(doc, { residency: store });
    const px = () => bg.buffer.getPixel(700, 700)[0];

    for (let i = 0; i < 5; i++) {
      await history.execute(registry.create(ctx, { name: 'invert', params: {} }));
      await store.enforceBudget();
    }
    const afterRuns = { pixel: px(), store: store.stats, disk: await swap.stats() };
    await history.goTo(0);
    const atStart = px();
    await history.goTo(5);
    const atEnd = px();
    await history.goTo(2);
    const atTwo = px();
    return { afterRuns, atStart, atEnd, atTwo, reloads: store.stats.reloads, shared: store.shared };
  },

  /** A folder left behind by a closed tab is deleted when a new scratch disk starts. */
  async staleFolderCleanup() {
    const root = await navigator.storage.getDirectory();
    const swapRoot = await root.getDirectoryHandle('swap', { create: true });
    await swapRoot.getDirectoryHandle('left-over-session', { create: true });
    const backend = await OpfsSwapBackend.create();
    if (!backend) throw new Error('OPFS unavailable');
    const { session } = await backend.stats();
    const folders = await swapFolders();
    await backend.dispose();
    return { session, folders, afterDispose: await swapFolders() };
  },

  /** Whether the scratch disk can start in this browser context. */
  async scratchDiskAvailable() {
    const backend = await OpfsSwapBackend.create();
    await backend?.dispose();
    return backend !== null;
  },
};

declare global {
  interface Window {
    __tiles?: typeof harness;
  }
}
window.__tiles = harness;
