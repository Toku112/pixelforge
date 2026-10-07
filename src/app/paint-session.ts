/**
 * A brush or eraser stroke being painted.
 *
 * For each batch of dabs it prepares the layer tiles they reach for the first time
 * (copy-on-write, capturing them for undo), sends the batch to the worker — one
 * batch at a time, later dabs waiting in a queue so painting never falls behind —
 * and marks the tiles changed so the canvas shows the stroke as it grows. When the
 * stroke ends it becomes one History step; cancelling restores the tiles.
 */
import { preparedStroke, type PaintTool } from '../core/commands/builtin/paint';
import { LayerTileDiff } from '../core/commands/tile-diff';
import type { ImageDocument } from '../core/document/document';
import type { PixelLayer } from '../core/document/layers';
import type { SampleArray } from '../core/document/pixel-format';
import { tileKey } from '../core/document/tile';
import type { BrushSettings, Dab, StrokePoint } from '../core/paint/brush';
import { dabTiles } from '../core/paint/stroke';
import type { PaintStroke } from '../tools/types';
import type { LiveStroke } from '../workers/stroke-client';
import type { Workspace } from './workspace';

export class PaintSession implements PaintStroke {
  readonly #workspace: Workspace;
  readonly #doc: ImageDocument;
  readonly #layer: PixelLayer;
  readonly #live: LiveStroke;
  readonly #tool: PaintTool;
  readonly #brush: BrushSettings;
  readonly #color: number[];
  readonly #diff: LayerTileDiff;
  readonly #touched = new Set<number>();
  readonly #queue: Dab[] = [];
  #flight: Promise<void> | null = null;
  #failed: unknown = null;
  #done = false;
  /** Settles when the stroke has been recorded or cancelled (tracked by the workspace). */
  readonly #finished: Promise<void>;
  #finish: () => void = () => {};

  constructor(
    workspace: Workspace,
    doc: ImageDocument,
    layer: PixelLayer,
    live: LiveStroke,
    tool: PaintTool,
    brush: BrushSettings,
    color: number[],
  ) {
    this.#workspace = workspace;
    this.#doc = doc;
    this.#layer = layer;
    this.#live = live;
    this.#tool = tool;
    this.#brush = { ...brush };
    this.#color = color;
    this.#diff = new LayerTileDiff(layer.id);
    this.#finished = new Promise((resolve) => (this.#finish = resolve));
    workspace.trackWork(this.#finished);
  }

  add(dabs: Dab[]): void {
    if (this.#done || dabs.length === 0) return;
    this.#queue.push(...dabs);
    this.#pump();
  }

  #pump(): void {
    if (this.#flight || this.#queue.length === 0 || this.#failed) return;
    const dabs = this.#queue.splice(0);
    const layer = this.#layer;
    const coords = dabTiles(dabs, layer.offsetX, layer.offsetY);
    const fresh: { tx: number; ty: number; data: SampleArray }[] = [];
    for (const [tx, ty] of coords) {
      const key = tileKey(tx, ty);
      if (this.#touched.has(key)) continue;
      this.#touched.add(key);
      this.#diff.captureBefore(this.#doc, tx, ty);
      fresh.push({ tx, ty, data: layer.buffer.writableTile(tx, ty).data });
    }
    this.#flight = this.#live
      .paint(fresh, dabs)
      .then(() => {
        for (const [tx, ty] of coords) layer.buffer.markChanged(tx, ty);
      })
      .catch((error: unknown) => {
        this.#failed = error;
      })
      .finally(() => {
        this.#flight = null;
        this.#pump();
      });
  }

  async #drain(): Promise<void> {
    while (this.#flight) await this.#flight;
  }

  /** Finishes the stroke: one History step ("Brush Tool" / "Eraser"). */
  async end(points: StrokePoint[]): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    try {
      await this.#record(points);
    } finally {
      this.#finish();
    }
  }

  async #record(points: StrokePoint[]): Promise<void> {
    await this.#drain();
    this.#live.end();
    this.#diff.captureAfter(this.#doc);
    if (this.#failed) {
      this.#diff.undo(this.#doc);
      throw this.#failed instanceof Error ? this.#failed : new Error('Painting failed in the pixel worker');
    }
    if (this.#touched.size === 0) return;
    const params = {
      tool: this.#tool,
      points: points.flatMap((p) => [p.x, p.y, p.pressure]),
      brush: this.#brush,
      color: this.#color,
    };
    const diff = this.#diff;
    await this.#workspace.executePrepared(this.#doc, (ctx) => preparedStroke(ctx, params, diff));
  }

  /** Abandons the stroke, restoring the layer. */
  async cancel(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    this.#queue.length = 0;
    try {
      await this.#drain();
      this.#live.end();
      this.#diff.captureAfter(this.#doc);
      this.#diff.undo(this.#doc);
    } finally {
      this.#finish();
    }
  }
}
