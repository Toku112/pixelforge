/**
 * The patterns the app offers (brush Texture now; Fill and the Pattern Stamp later):
 * our built-in set, then the user's (imported with brushes now; Edit > Define Pattern
 * later), kept in IndexedDB.
 */
import { builtInPattern, builtInPatterns, type Pattern, type PatternSource } from '../core/pattern/pattern';
import { LibraryStoreAccess } from './library-db';

export class PatternLibrary implements PatternSource {
  readonly #user = new Map<string, Pattern>();
  readonly #store: LibraryStoreAccess<Pattern>;
  readonly #listeners = new Set<() => void>();
  readonly ready: Promise<void>;

  constructor(persist = true) {
    this.#store = new LibraryStoreAccess('patterns', persist);
    this.ready = this.#store.all().then((all) => {
      for (const p of all) if (!this.#user.has(p.id)) this.#user.set(p.id, p);
      this.#changed();
    });
  }

  get(id: string): Pattern | undefined {
    return this.#user.get(id) ?? builtInPattern(id);
  }

  /** In picker order: ours, then the user's. */
  list(): Pattern[] {
    return [...builtInPatterns(), ...this.#user.values()];
  }

  /** The user's patterns only. */
  userPatterns(): Pattern[] {
    return [...this.#user.values()];
  }

  async add(patterns: Pattern[]): Promise<void> {
    for (const p of patterns) this.#user.set(p.id, p);
    this.#changed();
    await Promise.all(patterns.map((p) => this.#store.put(p)));
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const l of this.#listeners) l();
  }
}
