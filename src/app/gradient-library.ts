/**
 * The Gradients panel's presets in groups, kept in IndexedDB (our default set the first
 * time; Restore Default Gradients brings it back).
 */
import { cloneGradient, defaultGradients, type Gradient, type GradientGroup } from '../core/paint/gradient';
import { LibraryStoreAccess } from './library-db';

interface StoredGradients {
  groups: GradientGroup[];
}

export interface GradientEntry {
  id: string;
  gradient: Gradient;
}

export class GradientLibrary {
  #groups: GradientGroup[] = defaultGradients();
  readonly #meta: LibraryStoreAccess<StoredGradients>;
  readonly #listeners = new Set<() => void>();
  readonly ready: Promise<void>;

  constructor(persist = true) {
    this.#meta = new LibraryStoreAccess('meta', persist);
    this.ready = this.#meta.get('gradients').then((saved) => {
      if (saved?.groups) {
        this.#groups = saved.groups;
        this.#changed();
      }
    });
  }

  groups(): readonly GradientGroup[] {
    return this.#groups;
  }

  find(id: string): GradientEntry | undefined {
    for (const g of this.#groups) {
      const e = g.gradients.find((x) => x.id === id);
      if (e) return e;
    }
    return undefined;
  }

  /** The group a preset is in. */
  groupOf(id: string): string | undefined {
    return this.#groups.find((g) => g.gradients.some((x) => x.id === id))?.name;
  }

  /** Adds a preset to a group (made if missing; the first group when none is named). */
  async add(entry: GradientEntry, group?: string): Promise<void> {
    const name = group ?? this.#groups[0]?.name ?? 'Gradients';
    let g = this.#groups.find((x) => x.name === name);
    if (!g) {
      g = { name, gradients: [] };
      this.#groups = [...this.#groups, g];
    }
    g.gradients = [...g.gradients, { id: entry.id, gradient: cloneGradient(entry.gradient) }];
    await this.#save();
  }

  async addGroup(name: string): Promise<void> {
    if (this.#groups.some((g) => g.name === name)) return;
    this.#groups = [...this.#groups, { name, gradients: [] }];
    await this.#save();
  }

  async remove(id: string): Promise<void> {
    this.#groups = this.#groups.map((g) => ({ ...g, gradients: g.gradients.filter((x) => x.id !== id) }));
    await this.#save();
  }

  async removeGroup(name: string): Promise<void> {
    this.#groups = this.#groups.filter((g) => g.name !== name);
    await this.#save();
  }

  async rename(id: string, name: string): Promise<void> {
    const e = this.find(id);
    if (!e) return;
    e.gradient = { ...e.gradient, name };
    await this.#save();
  }

  /** Imported groups go after the others (a group of the same name gets a number). */
  async import(groups: GradientGroup[]): Promise<void> {
    const names = new Set(this.#groups.map((g) => g.name));
    const renamed = groups.map((g) => {
      let name = g.name;
      for (let n = 2; names.has(name); n++) name = `${g.name} ${n}`;
      names.add(name);
      return { ...g, name };
    });
    this.#groups = [...this.#groups, ...renamed];
    await this.#save();
  }

  /** Brings back our default gradients; the user's gradients stay where they are. */
  async restoreDefaults(): Promise<void> {
    const defaults = defaultGradients();
    const ours = (id: string) => id.startsWith('pf-grad-');
    this.#groups = [
      ...defaults.map((d) => {
        const kept = this.#groups.find((g) => g.name === d.name);
        return { ...d, gradients: [...d.gradients, ...(kept?.gradients.filter((e) => !ours(e.id)) ?? [])] };
      }),
      ...this.#groups.filter((g) => !defaults.some((d) => d.name === g.name)),
    ];
    await this.#save();
  }

  async #save(): Promise<void> {
    this.#changed();
    await this.#meta.put({ groups: this.#groups }, 'gradients');
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const l of this.#listeners) l();
  }
}
