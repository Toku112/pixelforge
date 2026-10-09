/**
 * Undo/redo history and the History panel model.
 *
 * Entry 0 is the document's initial state (the "Open"/"New" snapshot); entry i ≥ 1
 * is the state after command i. Moving between entries undoes or redoes commands.
 * History operations are serialised: while an asynchronous command runs, undo,
 * redo and further commands wait their turn.
 *
 * When the number of states exceeds the limit (Preferences > Performance, default
 * 50), the oldest command is dropped. The initial entry then stays reachable as a
 * snapshot: jumping to it restores the captured state, after first saving the
 * current state as an anchor so the remaining entries can still be revisited.
 *
 * One entry is the History Brush source (the initial snapshot unless the user
 * chooses another in the History panel). Its state is captured when it is chosen,
 * so painting from it never has to step through the history. When the source
 * entry goes away (undone states discarded, oldest states dropped), the initial
 * snapshot becomes the source again.
 */
import type { Command, CommandDescriptor } from '../commands/command';
import { Emitter } from '../document/events';
import type { ImageDocument } from '../document/document';
import type { PixelLayer } from '../document/layers';
import { alwaysResident, type Tile, type TileResidency } from '../document/tile';
import { layerTiles, stateLayer, type HistorySource } from './history-source';
import { captureDocumentState, restoreDocumentState, stateTiles, type DocumentState } from './snapshot';

export const DEFAULT_HISTORY_STATES = 50;

export interface HistoryEntryView {
  readonly id: number;
  readonly label: string;
  /** True for the initial snapshot entry. */
  readonly snapshot: boolean;
  /** "past" entries are applied, "future" ones are undone (shown dimmed in the panel). */
  readonly status: 'past' | 'current' | 'future';
  /** The History Brush paints from this entry's state. */
  readonly source: boolean;
}

interface Entry {
  id: number;
  label: string;
  command: Command | null;
}

export interface HistoryOptions {
  /** Maximum number of command states kept (not counting the initial snapshot). */
  maxStates?: number;
  /** Label of the initial entry, e.g. "Open". */
  initialLabel?: string;
  /** Brings tiles moved to disk back into memory before undo/redo (default: none are ever moved). */
  residency?: TileResidency;
}

export class History implements HistorySource {
  readonly doc: ImageDocument;
  readonly changes = new Emitter<void>();
  readonly #residency: TileResidency;
  #maxStates: number;
  readonly #entries: Entry[];
  #current = 0;
  #nextId = 1;
  /** Snapshot of entry 0, needed once its following commands have been dropped. */
  readonly #initialState: DocumentState;
  #purged = false;
  /** A saved later state, used to leave the initial snapshot again after a purge. */
  #anchor: { index: number; state: DocumentState } | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  /** Queued or running operations. */
  #pending = 0;
  /** Entry index to return to with Toggle Last State. */
  #toggleTarget: number | null = null;
  /** The History Brush source: an entry id and its captured state (null: the initial snapshot's). */
  #source: { id: number; state: DocumentState | null };

  constructor(doc: ImageDocument, options: HistoryOptions = {}) {
    this.doc = doc;
    this.#residency = options.residency ?? alwaysResident;
    this.#maxStates = Math.max(1, options.maxStates ?? DEFAULT_HISTORY_STATES);
    this.#entries = [{ id: this.#nextId++, label: options.initialLabel ?? 'Open', command: null }];
    this.#initialState = captureDocumentState(doc);
    this.#source = { id: this.#entries[0]!.id, state: null };
  }

  get maxStates(): number {
    return this.#maxStates;
  }

  set maxStates(value: number) {
    this.#maxStates = Math.max(1, value);
    this.#purge();
    this.changes.emit();
  }

  /** True while a command or history move is queued or running. */
  get busy(): boolean {
    return this.#pending > 0;
  }

  get currentIndex(): number {
    return this.#current;
  }

  get length(): number {
    return this.#entries.length;
  }

  get canUndo(): boolean {
    return this.#current > this.#lowestUndoIndex();
  }

  get canRedo(): boolean {
    return this.#current < this.#entries.length - 1;
  }

  get entries(): HistoryEntryView[] {
    return this.#entries.map((e, i) => ({
      id: e.id,
      label: e.label,
      snapshot: i === 0,
      status: i < this.#current ? 'past' : i === this.#current ? 'current' : 'future',
      source: e.id === this.#source.id,
    }));
  }

  /** Index of the History Brush source entry. */
  get sourceIndex(): number {
    return Math.max(
      0,
      this.#entries.findIndex((e) => e.id === this.#source.id),
    );
  }

  /** The state the History Brush paints from. */
  get sourceState(): DocumentState {
    return this.#source.state ?? this.#initialState;
  }

  /**
   * Makes an entry the History Brush source (the History panel's source column). Its
   * state is captured now: for an entry other than the current one, by stepping there
   * and back.
   */
  setSource(index: number): Promise<void> {
    return this.#enqueue(async () => {
      const entry = this.#entries[index];
      if (!entry) throw new Error(`No history entry at index ${index}`);
      if (entry.id === this.#source.id) return;
      if (index === 0) {
        this.#source = { id: entry.id, state: null };
        return;
      }
      const back = this.#current;
      if (index !== back) {
        // Everything both trips need, loaded first, so the steps happen without waiting in between.
        await this.#residency.ensureResident(this.#pathTiles(back, index));
        await this.#moveTo(index);
      }
      const state = captureDocumentState(this.doc);
      if (index !== back) await this.#moveTo(back);
      this.#source = { id: entry.id, state };
    });
  }

  /** The source state's version of a layer of the document, its tiles in memory (see history-source.ts). */
  async sourceLayer(layerId: string): Promise<PixelLayer> {
    const layer = stateLayer(this.sourceState, this.doc, layerId);
    await this.#residency.ensureResident(layerTiles(layer));
    return layer;
  }

  /** The tiles undoing and redoing between two entries uses. */
  *#pathTiles(from: number, to: number): IterableIterator<Tile> {
    if (this.#purged && from === 0) {
      // Leaving the initial snapshot goes through the anchor; coming back restores the snapshot.
      yield* stateTiles(this.#initialState);
      if (!this.#anchor) return;
      yield* stateTiles(this.#anchor.state);
      from = this.#anchor.index;
    }
    for (let i = Math.min(from, to) + 1; i <= Math.max(from, to); i++)
      yield* this.#entries[i]!.command?.retainedTiles?.() ?? [];
  }

  /** The initial snapshot becomes the source again when the source entry is gone. */
  #keepSource(): void {
    if (!this.#entries.some((e) => e.id === this.#source.id)) this.#source = { id: this.#entries[0]!.id, state: null };
  }

  /** What a history step recorded (its command's descriptor), for Actions and diagnostics; null for snapshots. */
  descriptorOf(entryId: number): CommandDescriptor | null {
    return this.#entries.find((e) => e.id === entryId)?.command?.descriptor ?? null;
  }

  /** Memory held for undo/redo by the commands in the history, in bytes. */
  get undoBytes(): number {
    return this.#entries.reduce((sum, e) => sum + (e.command?.undoBytes ?? 0), 0);
  }

  /** Runs a command and records it. Undone states after the current one are discarded. */
  execute(command: Command): Promise<void> {
    return this.#enqueue(async () => {
      await command.execute();
      // Branching from the initial state: the new command starts from it, so it is undoable again.
      if (this.#current === 0) this.#purged = false;
      this.#entries.splice(this.#current + 1);
      this.#entries.push({ id: this.#nextId++, label: command.label, command });
      this.#current = this.#entries.length - 1;
      this.#anchor = null;
      this.#toggleTarget = null;
      this.#purge();
      this.#keepSource();
    });
  }

  undo(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.canUndo) await this.#moveTo(this.#current - 1);
    });
  }

  redo(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.canRedo) await this.#moveTo(this.#current + 1);
    });
  }

  /** Jumps to an entry (clicking a state in the History panel). */
  goTo(index: number): Promise<void> {
    return this.#enqueue(async () => {
      if (!Number.isInteger(index) || index < 0 || index >= this.#entries.length) {
        throw new Error(`No history entry at index ${index}`);
      }
      await this.#moveTo(index);
    });
  }

  /** Edit > Toggle Last State: switches between the current state and the previous one. */
  toggleLastState(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#toggleTarget !== null && this.#toggleTarget < this.#entries.length) {
        const back = this.#current;
        await this.#moveTo(this.#toggleTarget);
        this.#toggleTarget = back;
      } else if (this.canUndo) {
        const back = this.#current;
        await this.#moveTo(this.#current - 1);
        this.#toggleTarget = back;
      }
    });
  }

  #lowestUndoIndex(): number {
    // After a purge, the state before the oldest kept command is unknown; only a
    // direct jump (goTo(0)) reaches the initial snapshot.
    return this.#purged ? 1 : 0;
  }

  async #moveTo(target: number): Promise<void> {
    if (target === this.#current) return;
    if (this.#purged && target === 0) {
      this.#anchor ??= { index: this.#current, state: captureDocumentState(this.doc) };
      await this.#residency.ensureResident(stateTiles(this.#initialState));
      restoreDocumentState(this.doc, this.#initialState);
      this.#current = 0;
      return;
    }
    if (this.#purged && this.#current === 0) {
      if (!this.#anchor) throw new Error('History anchor missing');
      await this.#residency.ensureResident(stateTiles(this.#anchor.state));
      restoreDocumentState(this.doc, this.#anchor.state);
      this.#current = this.#anchor.index;
    }
    while (this.#current > target) {
      const command = this.#entries[this.#current]!.command!;
      await this.#residency.ensureResident(command.retainedTiles?.() ?? []);
      command.undo();
      this.#current--;
    }
    while (this.#current < target) {
      const command = this.#entries[this.#current + 1]!.command!;
      await this.#residency.ensureResident(command.retainedTiles?.() ?? []);
      command.redo();
      this.#current++;
    }
  }

  #purge(): void {
    while (this.#entries.length - 1 > this.#maxStates) {
      // Never drop the entry we are on; if the current state is the oldest command, keep it.
      if (this.#current <= 1) break;
      this.#entries.splice(1, 1);
      this.#current--;
      // An anchor for the dropped entry is useless; a fresh one is taken on the next jump to 0.
      if (this.#anchor)
        this.#anchor = this.#anchor.index === 1 ? null : { ...this.#anchor, index: this.#anchor.index - 1 };
      this.#purged = true;
      this.#toggleTarget = null;
    }
    this.#keepSource();
  }

  #enqueue(task: () => void | Promise<void>): Promise<void> {
    this.#pending++;
    const run = async () => {
      try {
        await task();
      } finally {
        this.#pending--;
        this.changes.emit();
      }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}
