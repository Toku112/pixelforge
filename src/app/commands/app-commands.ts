/**
 * App commands: what menus, the keyboard and (later) the command search invoke —
 * "Open…", "Undo", "Zoom In", "Hand Tool". Commands that change a document run
 * document Commands through its History; others act on the UI.
 *
 * Only implemented commands are registered. Menu items whose command is missing
 * stay hidden (CLAUDE.md §4: no placeholder menu items).
 */

export interface AppCommand {
  readonly id: string;
  /** Menu label, without the shortcut. "…" marks commands that open a dialog. */
  readonly label: string;
  run(): void | Promise<void>;
  /** Greyed out in menus and ignored by shortcuts when false. Default: enabled. */
  enabled?(): boolean;
  /** For toggles shown with a check mark (e.g. View > Show > Pixel Grid). */
  checked?(): boolean;
}

export class AppCommandRegistry {
  readonly #commands = new Map<string, AppCommand>();
  readonly #listeners = new Set<(id: string, error: unknown) => void>();

  register(command: AppCommand): void {
    if (this.#commands.has(command.id)) throw new Error(`App command "${command.id}" is already registered`);
    this.#commands.set(command.id, command);
  }

  get(id: string): AppCommand | undefined {
    return this.#commands.get(id);
  }

  has(id: string): boolean {
    return this.#commands.has(id);
  }

  isEnabled(id: string): boolean {
    const command = this.#commands.get(id);
    return !!command && (command.enabled?.() ?? true);
  }

  /** Runs a command if it exists and is enabled. Returns whether it ran. Errors go to `onError` listeners. */
  run(id: string): boolean {
    const command = this.#commands.get(id);
    if (!command || !(command.enabled?.() ?? true)) return false;
    try {
      const result = command.run();
      if (result instanceof Promise) result.catch((error: unknown) => this.#report(id, error));
    } catch (error) {
      this.#report(id, error);
    }
    return true;
  }

  /** Called when a command fails (to show the error to the user). */
  onError(listener: (id: string, error: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #report(id: string, error: unknown): void {
    if (this.#listeners.size === 0) console.error(`Command ${id} failed`, error);
    for (const listener of this.#listeners) listener(id, error);
  }
}
