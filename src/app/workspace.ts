/**
 * The workspace: open documents and the active one.
 *
 * Each open document is a session holding its History, its file handle (for Save)
 * and its saved view (zoom, position, rotation) for when the tab is shown again.
 * All document changes go through `execute()`, i.e. through the History.
 */
import type { CommandDescriptor, CommandServices } from '../core/commands/command';
import type { CommandRegistry } from '../core/commands/registry';
import { Emitter } from '../core/document/events';
import type { ImageDocument } from '../core/document/document';
import type { TileResidency } from '../core/document/tile';
import { History } from '../core/history/history';
import type { ViewportState } from '../engine/viewport/viewport';

export interface DocumentSession {
  readonly id: string;
  readonly doc: ImageDocument;
  readonly history: History;
  /** File the document was opened from or last saved to (enables Save in place). */
  fileHandle: FileSystemFileHandle | null;
  /** View to restore when the tab is shown again. */
  view: ViewportState | null;
  /** History entry id at the last save/open; the document is dirty when the current entry differs. */
  savedEntryId: number | null;
}

export interface WorkspaceOptions {
  registry: CommandRegistry;
  services: CommandServices;
  residency?: TileResidency;
  historyStates?: number;
}

export class Workspace {
  readonly changes = new Emitter<void>();
  readonly #options: WorkspaceOptions;
  readonly #sessions: DocumentSession[] = [];
  #activeId: string | null = null;
  #version = 0;
  #preview: { session: DocumentSession; undo: () => void | Promise<void> } | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceOptions) {
    this.#options = options;
  }

  /** Increases on every change (for UI subscriptions). */
  get version(): number {
    return this.#version;
  }

  get sessions(): readonly DocumentSession[] {
    return this.#sessions;
  }

  get active(): DocumentSession | null {
    return this.#sessions.find((s) => s.id === this.#activeId) ?? null;
  }

  get registry(): CommandRegistry {
    return this.#options.registry;
  }

  /** Adds an opened document and makes it active. */
  add(doc: ImageDocument, fileHandle: FileSystemFileHandle | null = null, initialLabel = 'Open'): DocumentSession {
    const history = new History(doc, {
      initialLabel,
      residency: this.#options.residency,
      maxStates: this.#options.historyStates,
    });
    const session: DocumentSession = {
      id: doc.id,
      doc,
      history,
      fileHandle,
      view: null,
      savedEntryId: history.entries[0]!.id,
    };
    history.changes.on(() => this.#changed());
    doc.changes.on((change) => {
      if (change.kind !== 'pixels') this.#changed(); // pixel edits are reported through the history
    });
    this.#sessions.push(session);
    this.#activeId = session.id;
    this.#changed();
    return session;
  }

  activate(id: string): void {
    if (!this.#sessions.some((s) => s.id === id) || this.#activeId === id) return;
    this.#activeId = id;
    this.#changed();
  }

  /** Activates the next (+1) or previous (−1) tab, wrapping around. */
  cycle(direction: 1 | -1): void {
    if (this.#sessions.length < 2) return;
    const i = this.#sessions.findIndex((s) => s.id === this.#activeId);
    this.activate(this.#sessions[(i + direction + this.#sessions.length) % this.#sessions.length]!.id);
  }

  /** Removes a document (the caller asks about unsaved changes first). */
  remove(id: string): void {
    const i = this.#sessions.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.#sessions.splice(i, 1);
    if (this.#activeId === id) this.#activeId = this.#sessions[Math.min(i, this.#sessions.length - 1)]?.id ?? null;
    this.#changed();
  }

  isDirty(session: DocumentSession): boolean {
    const current = session.history.entries[session.history.currentIndex];
    return current?.id !== session.savedEntryId;
  }

  markSaved(session: DocumentSession, fileHandle: FileSystemFileHandle | null, name?: string): void {
    session.savedEntryId = session.history.entries[session.history.currentIndex]?.id ?? null;
    if (fileHandle) session.fileHandle = fileHandle;
    if (name) session.doc.name = name;
    this.#changed();
  }

  /** Whether a registered document command can run on the active document. */
  canExecute(name: string): boolean {
    const session = this.active;
    if (!session || session.history.busy) return false;
    return this.registry.isAvailable(name, { doc: session.doc, services: this.#options.services });
  }

  /** Runs a document command on the active document through its History. */
  execute(descriptor: CommandDescriptor): Promise<void> {
    return this.#serial(async () => {
      await this.#undoPreview();
      const session = this.active;
      if (!session) throw new Error('No document is open');
      const command = this.registry.create({ doc: session.doc, services: this.#options.services }, descriptor);
      await session.history.execute(command);
    });
  }

  /**
   * Live preview while a value is being dragged (e.g. a layer's opacity): runs the
   * command on the active document without recording it, replacing the previous
   * preview. `execute()` (or `cancelPreview()`) undoes the preview first, so the
   * final value lands in the History as a single step from the original value.
   */
  preview(descriptor: CommandDescriptor): Promise<void> {
    return this.#serial(async () => {
      await this.#undoPreview();
      const session = this.active;
      if (!session || session.history.busy) return;
      const command = this.registry.create({ doc: session.doc, services: this.#options.services }, descriptor);
      await command.execute();
      this.#preview = { session, undo: () => command.undo() };
    });
  }

  /** Undoes a running preview (Escape, or before an undo/redo). */
  cancelPreview(): Promise<void> {
    return this.#serial(() => this.#undoPreview());
  }

  async #undoPreview(): Promise<void> {
    const preview = this.#preview;
    if (!preview) return;
    this.#preview = null;
    if (this.#sessions.includes(preview.session)) await preview.undo();
  }

  /** Runs tasks one after another, so previews and commands never interleave. */
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  get previewing(): boolean {
    return this.#preview !== null;
  }

  #changed(): void {
    this.#version++;
    this.changes.emit();
  }
}
