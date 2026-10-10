/**
 * A brush or eraser stroke being painted.
 *
 * For each batch of dabs it prepares the layer tiles they reach for the first time
 * (copy-on-write, capturing them for undo), sends the batch to the worker — one
 * batch at a time, later dabs waiting in a queue so painting never falls behind —
 * and marks the tiles changed so the canvas shows the stroke as it grows. When the
 * stroke ends it becomes one History step; cancelling restores the tiles. A stroke
 * begun while the one before it on the same document is still being finished waits
 * for it before touching any tile, so neither loses paint to the other's copies.
 *
 * Strokes from the history (History Brush, Erase to History) send the source
 * state's tiles that each batch needs along with it, once they are in memory. The
 * Art History Brush's dabs are placed here, from the pointer samples (`addPoints`),
 * once the source state can be read. A Mixer Brush stroke records what the brush held
 * as it began and hands on what it holds at the end.
 */
import { preparedStroke, type PaintTool, type StampPattern } from '../core/commands/builtin/paint';
import { sourceTilesFor } from '../core/history/history-source';
import type { ArtHistoryDabber, ArtHistoryOptions } from '../core/paint/art-history';
import type { MixerEnd, MixerStroke } from '../core/paint/mixer';
import { LayerTileDiff } from '../core/commands/tile-diff';
import type { ImageDocument } from '../core/document/document';
import type { PixelLayer } from '../core/document/layers';
import type { SampleArray } from '../core/document/pixel-format';
import { tileKey } from '../core/document/tile';
import { POINT_FIELDS, packPoints, type BrushSettings, type Dab, type StrokePoint } from '../core/paint/brush';
import { dabTiles } from '../core/paint/stroke';
import type { DynamicsColors } from '../core/paint/dynamics';
import type { Symmetry } from '../core/paint/symmetry';
import type { PaintStroke } from '../tools/types';
import type { LiveStroke } from '../workers/stroke-client';
import type { Workspace } from './workspace';

/** What a stroke takes beyond the brush (each only for the strokes that use it). */
export interface PaintSessionOptions {
  symmetry?: Symmetry | null;
  pattern?: StampPattern | null;
  /** Eraser: Erase to History. */
  toHistory?: boolean;
  /** History Brush, Erase to History: the source state's version of the layer, once in memory. */
  source?: Promise<PixelLayer> | null;
  /** Art History Brush: its options, and its dab placer once the source state can be read. */
  art?: { options: ArtHistoryOptions; dabber: Promise<ArtHistoryDabber> } | null;
  /**
   * Mixer Brush: what the brush starts with (once the stroke before has handed it on), and
   * where to hand on what it holds at the end (null when the stroke was not recorded).
   */
  mixer?: { stroke: Promise<MixerStroke>; finish(end: MixerEnd | null): void } | null;
}

/** The stroke begun last on each document, settling once it has been recorded or cancelled. */
const lastStroke = new WeakMap<ImageDocument, Promise<void>>();

export class PaintSession implements PaintStroke {
  readonly #workspace: Workspace;
  readonly #doc: ImageDocument;
  readonly #layer: PixelLayer;
  readonly #live: LiveStroke;
  readonly #tool: PaintTool;
  readonly #brush: BrushSettings;
  readonly #color: number[];
  readonly seed: number;
  readonly colors: DynamicsColors | null;
  readonly symmetry: Symmetry | null;
  readonly #pattern: StampPattern | null;
  readonly #toHistory: boolean;
  /** Settles when the source tiles can be read (at once for strokes without a source). */
  readonly #sourceReady: Promise<PixelLayer | null>;
  /** Source tiles already sent ("tx,ty"). */
  readonly #sourcesSent = new Set<string>();
  readonly #art: PaintSessionOptions['art'];
  #artDabber: ArtHistoryDabber | null = null;
  readonly #mixer: PaintSessionOptions['mixer'];
  /** What the Mixer Brush ended the recorded stroke with. */
  #mixerEnd: MixerEnd | null = null;
  /** Art History Brush pointer samples waiting for the dab placer. */
  readonly #points: StrokePoint[] = [];
  readonly #diff: LayerTileDiff;
  readonly #touched = new Set<number>();
  readonly #queue: Dab[] = [];
  #flight: Promise<void> | null = null;
  #failed: unknown = null;
  #done = false;
  /** Settles when the stroke has been recorded or cancelled (tracked by the workspace). */
  readonly #finished: Promise<void>;
  /** Settles when the stroke before this one on the document has been recorded or cancelled. */
  readonly #after: Promise<void>;
  #finish: () => void = () => {};

  constructor(
    workspace: Workspace,
    doc: ImageDocument,
    layer: PixelLayer,
    live: LiveStroke,
    tool: PaintTool,
    brush: BrushSettings,
    color: number[],
    seed: number,
    colors: DynamicsColors | null,
    options: PaintSessionOptions = {},
  ) {
    this.seed = seed;
    this.#pattern = options.pattern ?? null;
    this.#toHistory = options.toHistory === true;
    this.colors = colors;
    this.symmetry = options.symmetry ?? null;
    this.#sourceReady = options.source ?? Promise.resolve(null);
    this.#sourceReady.catch((error: unknown) => (this.#failed ??= error));
    this.#art = options.art;
    this.#mixer = options.mixer ?? null;
    this.#mixer?.stroke.catch((error: unknown) => (this.#failed ??= error));
    this.#art?.dabber.then(
      (dabber) => {
        this.#artDabber = dabber;
        this.#placeArt();
      },
      (error: unknown) => (this.#failed ??= error),
    );
    this.#workspace = workspace;
    this.#doc = doc;
    this.#layer = layer;
    this.#live = live;
    this.#tool = tool;
    this.#brush = structuredClone(brush); // its own copy: settings changed later do not alter the record
    this.#color = color;
    this.#diff = new LayerTileDiff(layer.id);
    this.#finished = new Promise((resolve) => (this.#finish = resolve));
    workspace.trackWork(this.#finished);
    this.#after = lastStroke.get(doc) ?? Promise.resolve();
    lastStroke.set(doc, this.#finished);
  }

  add(dabs: Dab[]): void {
    if (this.#done || dabs.length === 0) return;
    this.#queue.push(...dabs);
    this.#pump();
  }

  /** Art History Brush: pointer samples (its dabs are placed here). */
  addPoints(points: StrokePoint[]): void {
    if (this.#done) return;
    this.#points.push(...points);
    this.#placeArt();
  }

  #placeArt(): void {
    const dabber = this.#artDabber;
    if (!dabber || this.#points.length === 0) return;
    const dabs = this.#points.splice(0).flatMap((p) => dabber.add(p));
    if (dabs.length > 0) {
      this.#queue.push(...dabs);
      this.#pump();
    }
  }

  #pump(): void {
    if (this.#flight || this.#queue.length === 0 || this.#failed) return;
    const dabs = this.#queue.splice(0);
    this.#flight = this.#after
      .then(() => this.#paint(dabs))
      .catch((error: unknown) => {
        this.#failed = error;
      })
      .finally(() => {
        this.#flight = null;
        this.#pump();
      });
  }

  /** Prepares the tiles a batch reaches first, paints it in the worker and shows the changed tiles. */
  async #paint(dabs: Dab[]): Promise<void> {
    const layer = this.#layer;
    const dual = this.#brush.dynamics?.dual;
    const coords = dabTiles(
      dabs,
      layer.offsetX,
      layer.offsetY,
      this.#brush.tip !== null,
      !!dual?.enabled && dual.tip !== null,
    );
    const fresh: { tx: number; ty: number; data: SampleArray }[] = [];
    for (const [tx, ty] of coords) {
      const key = tileKey(tx, ty);
      if (this.#touched.has(key)) continue;
      this.#touched.add(key);
      this.#diff.captureBefore(this.#doc, tx, ty);
      fresh.push({ tx, ty, data: layer.buffer.writableTile(tx, ty).data });
    }
    const source = await this.#sourceReady;
    const sources = source
      ? sourceTilesFor(
          source,
          fresh.map((t) => [t.tx, t.ty] as const),
          layer.offsetX,
          layer.offsetY,
          this.#sourcesSent,
        )
      : [];
    await this.#live.paint(fresh, dabs, sources);
    for (const [tx, ty] of coords) layer.buffer.markChanged(tx, ty);
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
      this.#mixer?.finish(this.#mixerEnd);
      this.#finish();
    }
  }

  async #record(points: StrokePoint[]): Promise<void> {
    if (this.#art) {
      // The last samples' dabs, once the placer is there.
      await this.#art.dabber.catch(() => undefined);
      this.#placeArt();
    }
    await this.#drain();
    const mixerEnd =
      this.#mixer && !this.#failed && this.#touched.size > 0
        ? await this.#live.mixerEnd().catch((error: unknown) => {
            this.#failed ??= error;
            return null;
          })
        : null;
    this.#live.end();
    this.#diff.captureAfter(this.#doc);
    if (this.#failed) {
      this.#diff.undo(this.#doc);
      throw this.#failed instanceof Error ? this.#failed : new Error('Painting failed in the pixel worker');
    }
    if (this.#touched.size === 0) return;
    const params = {
      tool: this.#tool,
      points: packPoints(points),
      stride: POINT_FIELDS.length,
      brush: this.#brush,
      color: this.#color,
      seed: this.seed,
      ...(this.colors ? { colors: { foreground: this.colors.foreground, background: this.colors.background } } : {}),
      ...(this.symmetry ? { symmetry: { ...this.symmetry } } : {}),
      ...(this.#pattern ? { pattern: { ...this.#pattern } } : {}),
      ...(this.#toHistory ? { toHistory: true } : {}),
      ...(this.#art ? { art: { ...this.#art.options } } : {}),
      ...(this.#mixer ? { mixer: await this.#mixer.stroke } : {}),
    };
    const diff = this.#diff;
    await this.#workspace.executePrepared(this.#doc, (ctx) => preparedStroke(ctx, params, diff));
    this.#mixerEnd = mixerEnd;
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
      this.#mixer?.finish(null);
      this.#finish();
    }
  }
}
