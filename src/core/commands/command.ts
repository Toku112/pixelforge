/**
 * Commands (CLAUDE.md §3.2): every change to a document is a Command with
 * execute/undo/redo, a JSON descriptor and a History label. The descriptor is
 * what Actions record and replay, what scripts send, and what the crash-recovery
 * journal stores; `CommandRegistry` turns a descriptor back into a command.
 */
import type { ImageDocument } from '../document/document';
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
  /** Inverts colour samples (max − value), leaving alpha unchanged. 8/16-bit only. */
  invert(tiles: SampleArray[], format: PixelFormat): Promise<void>;
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
}

export interface CommandServices {
  pixelOps: PixelOps;
}

export interface CommandContext {
  doc: ImageDocument;
  services: CommandServices;
}

/** Thrown when a command cannot run in the current state (e.g. no active pixel layer). */
export class CommandUnavailableError extends Error {
  override readonly name = 'CommandUnavailableError';
}
