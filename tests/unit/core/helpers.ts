import type { CommandContext, PixelOps } from '../../../src/core/commands/command';
import { CommandRegistry } from '../../../src/core/commands/registry';
import { registerBuiltinCommands } from '../../../src/core/commands/builtin';
import { ImageDocument, type DocumentInit } from '../../../src/core/document/document';
import { convertAlphaTile } from '../../../src/core/commands/alpha';
import { maxSampleValue, type PixelFormat, type SampleArray } from '../../../src/core/document/pixel-format';

/** Straightforward TypeScript implementation of PixelOps (the app uses WebAssembly in a worker). */
export const referencePixelOps: PixelOps = {
  invert(tiles: SampleArray[], format: PixelFormat) {
    const max = maxSampleValue(format.depth);
    const spp = format.colorChannels + (format.hasAlpha ? 1 : 0);
    for (const t of tiles) {
      for (let i = 0; i < t.length; i += spp) {
        for (let c = 0; c < format.colorChannels; c++) t[i + c] = max - t[i + c]!;
      }
    }
    return Promise.resolve();
  },
  convertAlpha(tiles, from, to, matte) {
    return Promise.resolve(tiles.map((t) => convertAlphaTile(t, from, to, matte)));
  },
};

export function createRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  return registry;
}

export function createContext(init: Partial<DocumentInit> = {}, pixelOps: PixelOps = referencePixelOps) {
  const doc = new ImageDocument({ width: 300, height: 200, ...init });
  const ctx: CommandContext = { doc, services: { pixelOps } };
  return { doc, ctx, registry: createRegistry() };
}

/** Adds a white Background and makes it active. */
export function withBackground<T extends { doc: ImageDocument }>(env: T): T {
  const bg = env.doc.createBackgroundLayer();
  env.doc.insertLayer(bg);
  env.doc.setActiveLayer(bg.id);
  return env;
}
