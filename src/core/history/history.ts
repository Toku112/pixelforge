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
 */
import type { Command, CommandDescriptor } from '../commands/command';
import { Emitter } from '../document/events';
import type { ImageDocument } from '../document/document';
import { alwaysResident, type TileResidency } from '../document/tile';
import { captureDocumentState, restoreDocumentState, stateTiles, type DocumentState } from './snapshot';

export const DEFAULT_HISTORY_STATES = 50;

export interface HistoryEntryView {
  readonly id: number;
  readonly label: string;
  /** True for the initial snapshot entry. */
  readonly snapshot: boolean;
  /** "past" entries are applied, "future" ones are undone (shown dimmed in the panel). */
  readonly status: 'past' | 'current' | 'future';
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

export class History {
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

  constructor(doc: ImageDocument, options: HistoryOptions = {}) {
    this.doc = doc;
    this.#residency = options.residency ?? alwaysResident;
    this.#maxStates = Math.max(1, options.maxStates ?? DEFAULT_HISTORY_STATES);
    this.#entries = [{ id: this.#nextId++, label: options.initialLabel ?? 'Open', command: null }];
    this.#initialState = captureDocumentState(doc);
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
    }));
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
