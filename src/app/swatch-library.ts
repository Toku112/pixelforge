/**
 * The Swatches panel's colours in groups, kept in IndexedDB (our default set the first
 * time; Restore Default Swatches brings it back).
 */
import type { RGB } from '../core/color/color';
import { defaultSwatches, type Swatch, type SwatchGroup } from '../core/color/swatches';
import { LibraryStoreAccess } from './library-db';

interface StoredSwatches {
  groups: SwatchGroup[];
}

export class SwatchLibrary {
  #groups: SwatchGroup[] = defaultSwatches();
  readonly #meta: LibraryStoreAccess<StoredSwatches>;
  readonly #listeners = new Set<() => void>();
  readonly ready: Promise<void>;

  constructor(persist = true) {
    this.#meta = new LibraryStoreAccess('meta', persist);
    this.ready = this.#meta.get('swatches').then((saved) => {
      if (saved?.groups) {
        this.#groups = saved.groups;
        this.#changed();
      }
    });
  }

  groups(): readonly SwatchGroup[] {
    return this.#groups;
  }

  find(id: string): Swatch | undefined {
    for (const g of this.#groups) {
      const s = g.swatches.find((w) => w.id === id);
      if (s) return s;
    }
    return undefined;
  }

  /** Adds a swatch to a group (made if missing; the first group when none is named). */
  async add(swatch: Swatch, group?: string): Promise<void> {
    const name = group ?? this.#groups[0]?.name ?? 'Swatches';
    let g = this.#groups.find((x) => x.name === name);
    if (!g) {
      g = { name, swatches: [] };
      this.#groups = [...this.#groups, g];
    }
    g.swatches = [...g.swatches, swatch];
    await this.#save();
  }

  async addGroup(name: string): Promise<void> {
    if (this.#groups.some((g) => g.name === name)) return;
    this.#groups = [...this.#groups, { name, swatches: [] }];
    await this.#save();
  }

  async remove(id: string): Promise<void> {
    this.#groups = this.#groups.map((g) => ({ ...g, swatches: g.swatches.filter((s) => s.id !== id) }));
    await this.#save();
  }

  async rename(id: string, name: string): Promise<void> {
    const s = this.find(id);
    if (!s) return;
    s.name = name;
    await this.#save();
  }

  /** Imported groups go after the others (a group of the same name gets a number). */
  async import(groups: SwatchGroup[]): Promise<void> {
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

  /** Brings back our default swatches; the user's swatches stay where they are. */
  async restoreDefaults(): Promise<void> {
    const defaults = defaultSwatches();
    const ours = (id: string) => id.startsWith('pf-');
    this.#groups = [
      ...defaults.map((d) => {
        const kept = this.#groups.find((g) => g.name === d.name);
        return { ...d, swatches: [...d.swatches, ...(kept?.swatches.filter((s) => !ours(s.id)) ?? [])] };
      }),
      ...this.#groups.filter((g) => !defaults.some((d) => d.name === g.name)),
    ];
    await this.#save();
  }

  /** A colour already in the swatches (for the Color panel's "add to swatches"). */
  has(color: RGB): boolean {
    const close = (a: number, b: number) => Math.abs(a - b) < 0.5 / 255;
    return this.#groups.some((g) =>
      g.swatches.some((s) => close(s.color.r, color.r) && close(s.color.g, color.g) && close(s.color.b, color.b)),
    );
  }

  async #save(): Promise<void> {
    this.#changed();
    await this.#meta.put({ groups: this.#groups }, 'swatches');
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const l of this.#listeners) l();
  }
}
