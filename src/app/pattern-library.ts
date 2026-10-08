/**
 * The patterns the app offers (brush Texture, Edit > Fill, the Pattern Stamp): our
 * built-in set, then the user's (Edit > Define Pattern, imported .pat files and brush
 * files), kept in IndexedDB, shown in groups in the Patterns panel.
 *
 * Built-in patterns stay available by id even when removed from the panel (brushes
 * and recordings may use them); Restore Default Patterns shows them again.
 */
import {
  builtInPattern,
  builtInPatterns,
  defaultPatternGroups,
  isBuiltInPattern,
  type Pattern,
  type PatternGroup,
  type PatternSource,
} from '../core/pattern/pattern';
import { LibraryStoreAccess } from './library-db';

/** Group of the user's patterns that are in no other group (e.g. from brush files). */
const OTHER = 'Other Patterns';

export class PatternLibrary implements PatternSource {
  readonly #user = new Map<string, Pattern>();
  readonly #store: LibraryStoreAccess<Pattern>;
  readonly #meta: LibraryStoreAccess<{ groups: PatternGroup[] }>;
  #groups: PatternGroup[] = defaultPatternGroups();
  readonly #listeners = new Set<() => void>();
  readonly ready: Promise<void>;

  constructor(persist = true) {
    this.#store = new LibraryStoreAccess('patterns', persist);
    this.#meta = new LibraryStoreAccess('meta', persist);
    this.ready = Promise.all([this.#store.all(), this.#meta.get('patternGroups')]).then(([all, saved]) => {
      for (const p of all) if (!this.#user.has(p.id)) this.#user.set(p.id, p);
      if (saved?.groups) this.#groups = saved.groups;
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

  /** The Patterns panel's groups with their patterns (the user's ungrouped ones last, in "Other Patterns"). */
  groups(): { name: string; patterns: Pattern[] }[] {
    const grouped = new Set(this.#groups.flatMap((g) => g.ids));
    const out = this.#groups.map((g) => ({
      name: g.name,
      patterns: g.ids.map((id) => this.get(id)).filter((p): p is Pattern => p !== undefined),
    }));
    const other = [...this.#user.values()].filter((p) => !grouped.has(p.id));
    if (other.length > 0) {
      const existing = out.find((g) => g.name === OTHER);
      if (existing) existing.patterns.push(...other);
      else out.push({ name: OTHER, patterns: other });
    }
    return out;
  }

  /** The group a pattern is shown in. */
  groupOf(id: string): string | undefined {
    return this.groups().find((g) => g.patterns.some((p) => p.id === id))?.name;
  }

  /** Adds patterns (to a group when named: made if missing). */
  async add(patterns: Pattern[], group?: string): Promise<void> {
    for (const p of patterns) this.#user.set(p.id, p);
    if (group !== undefined) {
      const g = this.#groups.find((x) => x.name === group);
      const ids = patterns.map((p) => p.id);
      this.#groups = g
        ? this.#groups.map((x) => (x === g ? { ...x, ids: [...x.ids, ...ids] } : x))
        : [...this.#groups, { name: group, ids }];
    }
    this.#changed();
    await Promise.all([...patterns.map((p) => this.#store.put(p)), this.#saveGroups()]);
  }

  async addGroup(name: string): Promise<void> {
    if (this.#groups.some((g) => g.name === name)) return;
    this.#groups = [...this.#groups, { name, ids: [] }];
    this.#changed();
    await this.#saveGroups();
  }

  /** A group name not used yet (`name`, else `name 2`, `name 3`…). */
  freeGroupName(name: string): string {
    const names = new Set(this.groups().map((g) => g.name));
    let free = name;
    for (let n = 2; names.has(free); n++) free = `${name} ${n}`;
    return free;
  }

  async rename(id: string, name: string): Promise<void> {
    const p = this.#user.get(id);
    if (p) {
      const renamed = { ...p, name };
      this.#user.set(id, renamed);
      this.#changed();
      await this.#store.put(renamed);
      return;
    }
    // A built-in pattern keeps its name.
  }

  /** Takes a pattern out of the panel (the user's: deleted; ours: hidden until restored). */
  async remove(id: string): Promise<void> {
    this.#groups = this.#groups.map((g) => ({ ...g, ids: g.ids.filter((x) => x !== id) }));
    const user = this.#user.delete(id);
    this.#changed();
    await Promise.all([this.#saveGroups(), user ? this.#store.delete(id) : Promise.resolve()]);
  }

  isUserPattern(id: string): boolean {
    return this.#user.has(id);
  }

  /** Shows our default patterns again; the user's patterns stay where they are. */
  async restoreDefaults(): Promise<void> {
    const defaults = defaultPatternGroups();
    const own = (g: PatternGroup) => g.ids.filter((id) => !isBuiltInPattern(id));
    this.#groups = [
      ...defaults.map((d) => {
        const kept = this.#groups.find((g) => g.name === d.name);
        return { ...d, ids: [...d.ids, ...(kept ? own(kept) : [])] };
      }),
      ...this.#groups.filter((g) => !defaults.some((d) => d.name === g.name)).map((g) => ({ ...g, ids: own(g) })),
    ];
    this.#changed();
    await this.#saveGroups();
  }

  async #saveGroups(): Promise<void> {
    await this.#meta.put({ groups: this.#groups }, 'patternGroups');
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const l of this.#listeners) l();
  }
}
