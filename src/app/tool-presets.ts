/**
 * Tool presets (Tool Presets panel, the options bar's tool preset picker): a tool with
 * its options, saved under a name, kept in IndexedDB.
 */
import { LibraryStoreAccess } from './library-db';

export interface ToolPreset {
  id: string;
  name: string;
  toolId: string;
  /** The tool's options (plain data). */
  options: unknown;
  order: number;
}

export class ToolPresetLibrary {
  readonly #presets = new Map<string, ToolPreset>();
  readonly #store: LibraryStoreAccess<ToolPreset>;
  readonly #listeners = new Set<() => void>();
  #next = 0;
  readonly ready: Promise<void>;

  constructor(persist = true) {
    this.#store = new LibraryStoreAccess('toolPresets', persist);
    this.ready = this.#store.all().then((all) => {
      for (const p of all) {
        this.#presets.set(p.id, p);
        this.#next = Math.max(this.#next, p.order + 1);
      }
      this.#changed();
    });
  }

  /** Every preset (or a tool's), in the order they were made. */
  list(toolId?: string): ToolPreset[] {
    return [...this.#presets.values()]
      .filter((p) => toolId === undefined || p.toolId === toolId)
      .sort((a, b) => a.order - b.order);
  }

  get(id: string): ToolPreset | undefined {
    return this.#presets.get(id);
  }

  async add(preset: Omit<ToolPreset, 'order'>): Promise<void> {
    const p = { ...preset, options: JSON.parse(JSON.stringify(preset.options)) as unknown, order: this.#next++ };
    this.#presets.set(p.id, p);
    this.#changed();
    await this.#store.put(p);
  }

  async rename(id: string, name: string): Promise<void> {
    const p = this.#presets.get(id);
    if (!p) return;
    p.name = name;
    this.#changed();
    await this.#store.put(p);
  }

  async remove(id: string): Promise<void> {
    if (!this.#presets.delete(id)) return;
    this.#changed();
    await this.#store.delete(id);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const l of this.#listeners) l();
  }
}
