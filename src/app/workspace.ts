/**
 * The workspace: open documents and the active one.
 *
 * Each open document is a session holding its History, its file handle (for Save)
 * and its saved view (zoom, position, rotation) for when the tab is shown again.
 * All document changes go through `execute()`, i.e. through the History.
 */
import type { Command, CommandContext, CommandDescriptor, CommandServices } from '../core/commands/command';
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

/** Progress of a long-running command, for the status bar. */
export interface TaskProgress {
  label: string;
  /** 0–1. */
  fraction: number;
}

/** Progress is only shown for commands still running after this long. */
const PROGRESS_DELAY_MS = 250;

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
  #task: { control: { cancelled: boolean }; label: string; fraction: number; shown: boolean } | null = null;
  #queue: Promise<void> = Promise.resolve();
  readonly #work = new Set<Promise<unknown>>();
  #nextPreview: CommandDescriptor | null = null;
  #previewRun: Promise<void> | null = null;

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

  /**
   * Runs a document command on the active document through its History. Long runs
   * report progress (see `task`) and can be cancelled with `cancelTask()`.
   */
  execute(descriptor: CommandDescriptor): Promise<void> {
    return this.#serial(async () => {
      await this.#undoPreview();
      const session = this.active;
      if (!session) throw new Error('No document is open');
      const control = { cancelled: false, progress: (f: number) => this.#reportProgress(f) };
      const command = this.registry.create(
        { doc: session.doc, services: this.#options.services, task: control },
        descriptor,
      );
      const timer = setTimeout(() => {
        if (this.#task?.control === control) {
          this.#task.shown = true;
          this.#changed();
        }
      }, PROGRESS_DELAY_MS);
      this.#task = { control, label: command.label, fraction: 0, shown: false };
      try {
        await session.history.execute(command);
      } finally {
        clearTimeout(timer);
        const shown = this.#task.shown;
        this.#task = null;
        if (shown) this.#changed();
      }
    });
  }

  /**
   * Records a change already made to `doc` (e.g. a brush stroke painted live) as one
   * History step; `build` makes the command holding its undo data.
   */
  executePrepared(doc: ImageDocument, build: (ctx: CommandContext) => Command): Promise<void> {
    return this.#serial(async () => {
      await this.#undoPreview();
      const session = this.#sessions.find((s) => s.doc === doc);
      if (!session) return; // closed meanwhile
      await session.history.execute(build({ doc, services: this.#options.services }));
    });
  }

  /** The command running long enough to show progress (after a short delay), or null. */
  get task(): TaskProgress | null {
    const t = this.#task;
    return t?.shown ? { label: t.label, fraction: t.fraction } : null;
  }

  /** True while a command runs (even before its progress is shown). */
  get running(): boolean {
    return this.#task !== null;
  }

  /** Asks the running command to stop (Esc); it then leaves the document unchanged. */
  cancelTask(): void {
    if (this.#task) this.#task.control.cancelled = true;
  }

  #reportProgress(fraction: number): void {
    const t = this.#task;
    if (!t) return;
    const previous = t.fraction;
    t.fraction = Math.min(1, Math.max(0, fraction));
    if (t.shown && Math.floor(t.fraction * 100) !== Math.floor(previous * 100)) this.#changed();
  }

  /**
   * Live preview while a value is being dragged (e.g. a layer's opacity): runs the
   * command on the active document without recording it, replacing the previous
   * preview. `execute()` (or `cancelPreview()`) undoes the preview first, so the
   * final value lands in the History as a single step from the original value.
   */
  preview(descriptor: CommandDescriptor): Promise<void> {
    // Previews arriving faster than they run collapse: only the latest is shown.
    this.#nextPreview = descriptor;
    this.#previewRun ??= this.#serial(async () => {
      const latest = this.#nextPreview!;
      this.#nextPreview = null;
      this.#previewRun = null;
      await this.#undoPreview();
      const session = this.active;
      if (!session || session.history.busy) return;
      const command = this.registry.create({ doc: session.doc, services: this.#options.services }, latest);
      await command.execute();
      this.#preview = { session, undo: () => command.undo() };
    });
    return this.#previewRun;
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

  /**
   * Resolves once every command, preview and tracked piece of work (e.g. a brush
   * stroke being finished) has completed — also when they failed.
   */
  async whenIdle(): Promise<void> {
    do {
      await Promise.allSettled([...this.#work]);
      await this.#queue;
    } while (this.#work.size > 0);
  }

  /** Work that changes documents outside `execute()` (a live brush stroke), for `whenIdle()`. */
  trackWork(work: Promise<unknown>): void {
    this.#work.add(work);
    void work.finally(() => this.#work.delete(work));
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
