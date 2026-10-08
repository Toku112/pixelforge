/**
 * Creates the app's long-lived services: tile memory with its scratch disk, the
 * workers, the document command registry and the workspace.
 */
import { registerBuiltinCommands } from '../core/commands/builtin';
import type { PixelOps } from '../core/commands/command';
import type { Dab } from '../core/paint/brush';
import type { StrokeSetup } from '../core/paint/stroke';
import { BrushLibrary } from './brush-library';
import { PatternLibrary } from './pattern-library';
import { Preferences } from './preferences';
import type { Thumbnail, ThumbnailSource } from '../core/composite/thumbnail';
import type { Rect } from '../core/document/geometry';
import { CommandRegistry } from '../core/commands/registry';
import type { MaskData } from '../core/selection/selection';
import { OpfsSwapBackend } from '../engine/tiles/opfs-swap';
import { TileStore, defaultMemoryBudget } from '../engine/tiles/tile-store';
import { createCodecWorker, type CodecWorkerClient } from '../workers/codec-client';
import { createPixelWorker } from '../workers/pixel-client';
import { createWorkerPixelOps } from '../workers/pixel-ops-client';
import { createStrokeEngine, type StrokeEngine } from '../workers/stroke-client';
import { Workspace } from './workspace';

/** Renders a layer thumbnail off the main thread. */
export type ThumbnailRenderer = (
  source: ThumbnailSource,
  area: Rect,
  width: number,
  height: number,
) => Promise<Thumbnail>;

/** Traces a selection's marching-ants outline off the main thread (closed loops, document coordinates). */
export type OutlineTracer = (mask: MaskData, canvas: Rect) => Promise<Float32Array[]>;

export interface AppServices {
  tileStore: TileStore;
  codec: CodecWorkerClient;
  workspace: Workspace;
  renderThumbnail: ThumbnailRenderer;
  traceOutline: OutlineTracer;
  /** The Brush Settings preview strip (RGBA rows, at most 256 × 256). */
  brushPreview: (setup: StrokeSetup, dabs: Dab[], width: number, height: number) => Promise<Uint8Array>;
  /** The outline of a sampled brush tip (tip pixels) where it paints half / at all, for the brush cursor. */
  traceTip: (
    tip: { width: number; height: number; data: Uint8Array },
    contour?: 'normal' | 'full',
  ) => Promise<Float32Array[]>;
  /** Live brush/eraser strokes in the pixel worker. */
  strokes: StrokeEngine;
  /** Pixel operations in the worker (also used by the commands). */
  pixelOps: PixelOps;
  /** The user's sampled brush tips. */
  brushes: BrushLibrary;
  /** Patterns (brush Texture). */
  patterns: PatternLibrary;
  /** Edit > Preferences. */
  preferences: Preferences;
}

export async function createServices(): Promise<AppServices> {
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const swap = await OpfsSwapBackend.create();
  const tileStore = new TileStore({ budgetBytes: defaultMemoryBudget(deviceMemory), swap });
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  const pixelWorker = createPixelWorker();
  const pixelOps = createWorkerPixelOps(pixelWorker);
  const brushes = new BrushLibrary();
  const patterns = new PatternLibrary();
  const workspace = new Workspace({
    registry,
    services: { pixelOps, brushTips: brushes, patterns },
    residency: tileStore,
  });
  return {
    tileStore,
    codec: createCodecWorker(),
    workspace,
    renderThumbnail: (source, area, width, height) => pixelWorker.layerThumbnail(source, area, width, height),
    traceOutline: (mask, canvas) => pixelWorker.selectionOutline(mask, canvas),
    traceTip: (tip, contour = 'normal') =>
      pixelWorker.tipOutline(tip.width, tip.height, tip.data, contour === 'full' ? 1 : 128),
    brushPreview: (setup, dabs, width, height) => pixelWorker.brushPreview(setup, dabs, width, height),
    strokes: createStrokeEngine(pixelWorker),
    pixelOps,
    brushes,
    patterns,
    preferences: new Preferences(),
  };
}
