/**
 * Commands (CLAUDE.md §3.2): every change to a document is a Command with
 * execute/undo/redo, a JSON descriptor and a History label. The descriptor is
 * what Actions record and replay, what scripts send, and what the crash-recovery
 * journal stores; `CommandRegistry` turns a descriptor back into a command.
 */
import type { CompositeTile } from '../composite/composite-tiles';
import type { Dab } from '../paint/brush';
import type { FillSpec } from '../paint/fill';
import type { MovePixelsSetup } from '../paint/move-pixels';
import type { StrokeSetup } from '../paint/stroke';
import type { MaskedTarget } from '../selection/masked-edits';
import type { SelectionMode, SelectionShape } from '../selection/mask-ops';
import type { MaskData } from '../selection/selection';
import type { FlattenPlan } from '../composite/flatten';
import type { ImageDocument } from '../document/document';
import type { Rect } from '../document/geometry';
import type { PixelFormat, SampleArray } from '../document/pixel-format';
import type { Tile } from '../document/tile';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Serialisable description of a command: enough to re-create and replay it. */
export interface CommandDescriptor {
  /** Registered command name, e.g. "invert". */
  readonly name: string;
  readonly params: JsonObject;
}

export interface Command {
  /** History panel label, e.g. "Invert". */
  readonly label: string;
  readonly descriptor: CommandDescriptor;
  /**
   * Applies the change. May be asynchronous (heavy work runs in a worker).
   * Must be atomic: if it throws, the document is left unchanged.
   */
  execute(): void | Promise<void>;
  /** Reverts the change. Synchronous: undo data is kept in memory. */
  undo(): void;
  /** Re-applies the change after an undo, from stored results (no recomputation). */
  redo(): void;
  /** Approximate memory held for undo/redo, in bytes. */
  readonly undoBytes: number;
  /**
   * Tiles kept for undo/redo. The tile store may move them to disk; the history
   * brings them back into memory before calling undo() or redo().
   */
  retainedTiles?(): Iterable<Tile>;
}

/**
 * Heavy pixel operations, implemented outside the pure core (WebAssembly in a worker
 * in the app; a direct implementation in tests). Each operation modifies the given
 * tile sample arrays in place.
 */
export interface PixelOps {
  /**
   * Inverts colour samples (max − value), leaving alpha unchanged. 8/16-bit only.
   * With `through`, only as much as the selection covers each pixel.
   */
  invert(tiles: SampleArray[], format: PixelFormat, through?: MaskedTarget): Promise<void>;
  /**
   * Edit > Clear through a selection: makes pixels transparent, or moves them
   * towards `fill` (colour samples) for layers without (editable) transparency.
   */
  clear(
    tiles: SampleArray[],
    format: PixelFormat,
    through: MaskedTarget,
    fill: readonly number[] | null,
  ): Promise<void>;
  /** The selection after drawing a shape (see core/selection/mask-ops.ts); null when nothing is left selected. */
  selectShape(
    current: MaskData | null,
    shape: SelectionShape,
    mode: SelectionMode,
    feather: number,
    antiAlias: boolean,
    canvas: Rect,
  ): Promise<MaskData | null>;
  /** Select > Inverse; null when nothing is left selected. */
  invertSelection(current: MaskData, canvas: Rect): Promise<MaskData | null>;
  /** Moves selected pixels (see core/paint/move-pixels.ts): reads `sources`, writes `outputs`. */
  movePixels(
    setup: MovePixelsSetup,
    sources: { tx: number; ty: number; data: SampleArray }[],
    outputs: { tx: number; ty: number; data: SampleArray }[],
  ): Promise<void>;
  /** Edit > Fill into layer tiles through a selection (see core/paint/fill.ts). */
  fill(tiles: SampleArray[], format: PixelFormat, through: MaskedTarget, spec: FillSpec, hdr: boolean): Promise<void>;
  /** Paints a whole brush/eraser stroke into layer tiles (`coords`: their layer tile coordinates). */
  paintStroke(setup: StrokeSetup, tiles: SampleArray[], coords: [number, number][], dabs: Dab[]): Promise<void>;
  /**
   * Converts whole tiles to a format that differs only in alpha: adds a fully
   * opaque alpha channel, or removes alpha by compositing over `matte` (colour
   * samples). Returns new arrays; the inputs are not modified.
   */
  convertAlpha(
    tiles: SampleArray[],
    from: PixelFormat,
    to: PixelFormat,
    matte: readonly number[],
  ): Promise<SampleArray[]>;
  /**
   * Composites a flatten plan over `rect` (document coordinates) into tiles of
   * `format` on the document's tile grid; without alpha, over `matte` (colour
   * samples). Empty tiles are left out. See core/composite/composite-tiles.ts.
   */
  composite(
    plan: FlattenPlan,
    rect: Rect,
    format: PixelFormat,
    matte: readonly number[] | null,
    task?: TaskControl,
  ): Promise<CompositeTile[]>;
}

/**
 * Progress and cancellation for one long command run (CLAUDE.md §3.4): heavy
 * operations report how far they are and stop between chunks once cancelled.
 */
export interface TaskControl {
  /** Set when the user cancels (Esc). Operations then throw CommandCancelledError. */
  readonly cancelled: boolean;
  /** Reports progress, 0–1. */
  progress(fraction: number): void;
}

/** Thrown by a command whose run was cancelled; the document is left unchanged. */
export class CommandCancelledError extends Error {
  override readonly name = 'CommandCancelledError';
  constructor() {
    super('Cancelled');
  }
}

export interface CommandServices {
  pixelOps: PixelOps;
}

export interface CommandContext {
  doc: ImageDocument;
  services: CommandServices;
  /** Progress/cancellation of this run, when the caller tracks it. */
  task?: TaskControl;
}

/** Thrown when a command cannot run in the current state (e.g. no active pixel layer). */
export class CommandUnavailableError extends Error {
  override readonly name = 'CommandUnavailableError';
}
