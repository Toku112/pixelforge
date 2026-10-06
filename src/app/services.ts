/**
 * Creates the app's long-lived services: tile memory with its scratch disk, the
 * workers, the document command registry and the workspace.
 */
import { registerBuiltinCommands } from '../core/commands/builtin';
import { CommandRegistry } from '../core/commands/registry';
import { OpfsSwapBackend } from '../engine/tiles/opfs-swap';
import { TileStore, defaultMemoryBudget } from '../engine/tiles/tile-store';
import { createCodecWorker, type CodecWorkerClient } from '../workers/codec-client';
import { createPixelWorker } from '../workers/pixel-client';
import { createWorkerPixelOps } from '../workers/pixel-ops-client';
import { Workspace } from './workspace';

export interface AppServices {
  tileStore: TileStore;
  codec: CodecWorkerClient;
  workspace: Workspace;
}

export async function createServices(): Promise<AppServices> {
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const swap = await OpfsSwapBackend.create();
  const tileStore = new TileStore({ budgetBytes: defaultMemoryBudget(deviceMemory), swap });
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  const pixelOps = createWorkerPixelOps(createPixelWorker());
  const workspace = new Workspace({ registry, services: { pixelOps }, residency: tileStore });
  return { tileStore, codec: createCodecWorker(), workspace };
}
