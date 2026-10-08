import { sampleArea } from '../../../src/core/paint/sample';
import { CommandCancelledError, type CommandContext, type PixelOps } from '../../../src/core/commands/command';
import { CommandRegistry } from '../../../src/core/commands/registry';
import { registerBuiltinCommands } from '../../../src/core/commands/builtin';
import { ImageDocument, type DocumentInit } from '../../../src/core/document/document';
import { convertAlphaTile } from '../../../src/core/commands/alpha';
import { compositeTiles } from '../../../src/core/composite/composite-tiles';
import { contentBounds, mapLayer, resampleLayer } from '../../../src/core/geometry/layer-geometry';
import {
  transformLayerPixels,
  transformMask,
  transformSelectedPixels,
} from '../../../src/core/geometry/transform-pixels';
import { tipFromImage } from '../../../src/core/paint/define-tip';
import { fillTiles } from '../../../src/core/paint/fill';
import { gradientTiles } from '../../../src/core/paint/gradient-fill';
import { patternFromImage } from '../../../src/core/pattern/define-pattern';
import { movePixels } from '../../../src/core/paint/move-pixels';
import { StrokeRenderer } from '../../../src/core/paint/stroke';
import { clearMasked, invertMasked } from '../../../src/core/selection/masked-edits';
import { invertSelection, maskBounds, selectShape } from '../../../src/core/selection/mask-ops';
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
  convertAlpha(tiles, from, to, matte, keep) {
    return Promise.resolve(tiles.map((t, i) => convertAlphaTile(t, from, to, matte, undefined, keep?.[i] ?? null)));
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
  contentBounds(source) {
    return Promise.resolve(contentBounds(source));
  },
  transformLayerPixels(setup, sources, area) {
    return Promise.resolve(transformLayerPixels(setup, sources, area));
  },
  transformSelectedPixels(setup, sources, outputs) {
    transformSelectedPixels(setup, sources, outputs);
    return Promise.resolve();
  },
  transformMask(mask, inverse, area, canvas) {
    return Promise.resolve(transformMask(mask, inverse, area, canvas));
  },
  sampleColor(plan, rect) {
    return Promise.resolve(sampleArea(plan, rect));
  },
  brushTipFromImage(plan, rect, mask, canvas) {
    return Promise.resolve(tipFromImage(plan, rect, mask, canvas));
  },
  patternFromImage(plan, rect, mask, canvas) {
    return Promise.resolve(patternFromImage(plan, rect, mask, canvas));
  },
  maskBounds(mask, canvas) {
    return Promise.resolve(maskBounds(mask, canvas));
  },
  transformLayer(source, geometry, fill) {
    return Promise.resolve(
      geometry.kind === 'map'
        ? mapLayer(source, geometry.map, geometry.clip, fill)
        : resampleLayer(source, geometry.scaleX, geometry.scaleY, geometry.method, geometry.clip, fill),
    );
  },
  movePixels(setup, sources, outputs) {
    movePixels(setup, sources, outputs);
    return Promise.resolve();
  },
  fill(tiles, format, through, spec, hdr) {
    fillTiles(tiles, format, through, spec, hdr);
    return Promise.resolve();
  },
  gradient(tiles, format, through, spec, hdr) {
    gradientTiles(tiles, format, through, spec, hdr);
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
