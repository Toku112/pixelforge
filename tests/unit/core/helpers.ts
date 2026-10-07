import { CommandCancelledError, type CommandContext, type PixelOps } from '../../../src/core/commands/command';
import { CommandRegistry } from '../../../src/core/commands/registry';
import { registerBuiltinCommands } from '../../../src/core/commands/builtin';
import { ImageDocument, type DocumentInit } from '../../../src/core/document/document';
import { convertAlphaTile } from '../../../src/core/commands/alpha';
import { compositeTiles } from '../../../src/core/composite/composite-tiles';
import { fillTiles } from '../../../src/core/paint/fill';
import { StrokeRenderer } from '../../../src/core/paint/stroke';
import { clearMasked, invertMasked } from '../../../src/core/selection/masked-edits';
import { invertSelection, selectShape } from '../../../src/core/selection/mask-ops';
import { maxSampleValue, type PixelFormat, type SampleArray } from '../../../src/core/document/pixel-format';

/** Straightforward TypeScript implementation of PixelOps (the app uses WebAssembly in a worker). */
export const referencePixelOps: PixelOps = {
  invert(tiles: SampleArray[], format: PixelFormat, through) {
    if (through) {
      invertMasked(tiles, format, through);
      return Promise.resolve();
    }
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
  clear(tiles, format, through, fill) {
    clearMasked(tiles, format, through, fill);
    return Promise.resolve();
  },
  selectShape(current, shape, mode, feather, antiAlias, canvas) {
    return Promise.resolve(selectShape(current, shape, mode, feather, antiAlias, canvas));
  },
  invertSelection(current, canvas) {
    return Promise.resolve(invertSelection(current, canvas));
  },
  fill(tiles, format, through, spec, hdr) {
    fillTiles(tiles, format, through, spec, hdr);
    return Promise.resolve();
  },
  paintStroke(setup, tiles, coords, dabs) {
    const renderer = new StrokeRenderer(setup);
    tiles.forEach((data, i) => renderer.addTile(coords[i]![0], coords[i]![1], data));
    renderer.applyDabs(dabs);
    return Promise.resolve();
  },
  composite(plan, rect, format, matte, task) {
    if (task?.cancelled) return Promise.reject(new CommandCancelledError());
    task?.progress(1);
    return Promise.resolve(compositeTiles(plan, rect, format, matte));
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
