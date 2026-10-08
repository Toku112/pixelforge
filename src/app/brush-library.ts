/**
 * The brush library: sampled tips (ours, built in, and the user's from Edit > Define
 * Brush Preset or imported files) and brush presets in groups, with the recently used
 * ones — kept in IndexedDB so they are there next time. Our default presets are
 * copied in the first time, so they can be renamed, moved or deleted like any other
 * (Restore Default Brushes brings them back).
 */
import type { BrushTipSource } from '../core/commands/command';
import type { BrushTip } from '../core/paint/brush';
import { builtInTip, builtInTips, isBuiltInTip } from '../core/paint/builtin-tips';
import { defaultPresets, parsePreset, type BrushPreset } from '../core/paint/presets';
import { LibraryStoreAccess } from './library-db';

/** A stored preset: its place in the list too. */
type StoredPreset = BrushPreset & { order: number };

interface BrushOrder {
  /** Group names in panel order (groups may be empty). */
  groups: string[];
  recent: string[];
  defaultsAdded: boolean;
}

/** How many recently used presets are remembered. */
const RECENT = 8;

export class BrushLibrary implements BrushTipSource {
  readonly #tips = new Map<string, BrushTip>();
  readonly #presets = new Map<string, StoredPreset>();
  #groups: string[] = [];
  #recent: string[] = [];
  #nextOrder = 0;
  readonly #listeners = new Set<() => void>();
  readonly #tipStore: LibraryStoreAccess<BrushTip>;
  readonly #presetStore: LibraryStoreAccess<StoredPreset>;
  readonly #meta: LibraryStoreAccess<BrushOrder>;
  /** Settles once the saved library is loaded. */
  readonly ready: Promise<void>;

  constructor(persist = true) {
    this.#tipStore = new LibraryStoreAccess('brushTips', persist);
    this.#presetStore = new LibraryStoreAccess('brushPresets', persist);
    this.#meta = new LibraryStoreAccess('meta', persist);
    this.ready = this.#load();
  }

  async #load(): Promise<void> {
    const [tips, presets, order] = await Promise.all([
      this.#tipStore.all(),
      this.#presetStore.all(),
      this.#meta.get('brushes'),
    ]);
    for (const tip of tips) if (!this.#tips.has(tip.id)) this.#tips.set(tip.id, tip);
    for (const raw of presets) {
      try {
        const p = { ...parsePreset(raw), order: raw.order };
        this.#presets.set(p.id, p);
        this.#nextOrder = Math.max(this.#nextOrder, p.order + 1);
      } catch {
        // A damaged stored preset is skipped.
      }
    }
    this.#groups = order?.groups ?? [];
    this.#recent = order?.recent ?? [];
    if (!order?.defaultsAdded) await this.restoreDefaults();
    this.#changed();
  }

  // -- tips -----------------------------------------------------------------

  /** A tip by id: the user's, or one of ours. */
  get(id: string): BrushTip | undefined {
    return this.#tips.get(id) ?? builtInTip(id);
  }

  /** Every tip: ours first, then the user's (oldest first). */
  list(): BrushTip[] {
    return [...builtInTips(), ...this.#tips.values()];
  }

  /** Whether a tip is the user's (built-in tips cannot be deleted). */
  isUserTip(id: string): boolean {
    return this.#tips.has(id) && !isBuiltInTip(id);
  }

  /** Adds (or replaces) a user tip and saves it. */
  async add(tip: BrushTip): Promise<void> {
    this.#tips.set(tip.id, tip);
    this.#changed();
    await this.#tipStore.put(tip);
  }

  async remove(id: string): Promise<void> {
    if (!this.#tips.delete(id)) return;
    this.#changed();
    await this.#tipStore.delete(id);
  }

  // -- presets ----------------------------------------------------------------

  /** Every preset, in list order. */
  presets(): BrushPreset[] {
    return [...this.#presets.values()].sort((a, b) => a.order - b.order).map(({ order: _, ...p }) => p);
  }

  preset(id: string): BrushPreset | undefined {
    const p = this.#presets.get(id);
    if (!p) return undefined;
    const { order: _, ...rest } = p;
    return rest;
  }

  /** Group names in order: the stored order, then any other group a preset names. */
  groups(): string[] {
    const out = [...this.#groups];
    for (const p of this.presets()) if (p.group !== null && !out.includes(p.group)) out.push(p.group);
    return out;
  }

  /** The recently used presets, most recent first. */
  recent(): BrushPreset[] {
    return this.#recent.map((id) => this.preset(id)).filter((p): p is BrushPreset => p !== undefined);
  }

  /** Adds or replaces presets (new ones go to the end), with the tips they bring. */
  async savePresets(presets: BrushPreset[], tips: BrushTip[] = []): Promise<void> {
    for (const tip of tips) this.#tips.set(tip.id, tip);
    const stored = presets.map((p) => ({ ...p, order: this.#presets.get(p.id)?.order ?? this.#nextOrder++ }));
    for (const p of stored) this.#presets.set(p.id, p);
    for (const p of presets) if (p.group !== null && !this.#groups.includes(p.group)) this.#groups.push(p.group);
    this.#changed();
    await Promise.all([
      ...tips.map((t) => this.#tipStore.put(t)),
      ...stored.map((p) => this.#presetStore.put(p)),
      this.#saveOrder(),
    ]);
  }

  async removePreset(id: string): Promise<void> {
    if (!this.#presets.delete(id)) return;
    this.#recent = this.#recent.filter((r) => r !== id);
    this.#changed();
    await Promise.all([this.#presetStore.delete(id), this.#saveOrder()]);
  }

  async renamePreset(id: string, name: string): Promise<void> {
    const p = this.#presets.get(id);
    if (!p) return;
    p.name = name;
    this.#changed();
    await this.#presetStore.put(p);
  }

  /** Moves a preset into a group (null: out of any), before `before` if given. */
  async movePreset(id: string, group: string | null, before?: string): Promise<void> {
    const p = this.#presets.get(id);
    if (!p) return;
    p.group = group;
    const target = before ? this.#presets.get(before) : undefined;
    if (target && target.id !== id) {
      // Make room: everything from the target on moves one place down.
      for (const q of this.#presets.values()) if (q.order >= target.order && q.id !== id) q.order++;
      p.order = target.order - 1;
    }
    this.#changed();
    await Promise.all([...this.#presets.values()].map((q) => this.#presetStore.put(q)));
  }

  async addGroup(name: string): Promise<void> {
    if (this.groups().includes(name)) return;
    this.#groups.push(name);
    this.#changed();
    await this.#saveOrder();
  }

  async renameGroup(from: string, to: string): Promise<void> {
    if (from === to || this.groups().includes(to)) return;
    this.#groups = this.groups().map((g) => (g === from ? to : g));
    const moved = [...this.#presets.values()].filter((p) => p.group === from);
    for (const p of moved) p.group = to;
    this.#changed();
    await Promise.all([...moved.map((p) => this.#presetStore.put(p)), this.#saveOrder()]);
  }

  /** Deletes a group and the presets in it. */
  async removeGroup(name: string): Promise<void> {
    const gone = [...this.#presets.values()].filter((p) => p.group === name);
    for (const p of gone) this.#presets.delete(p.id);
    this.#groups = this.groups().filter((g) => g !== name);
    this.#recent = this.#recent.filter((id) => this.#presets.has(id));
    this.#changed();
    await Promise.all([...gone.map((p) => this.#presetStore.delete(p.id)), this.#saveOrder()]);
  }

  /** Brings back our default presets (replacing changed copies of them). */
  async restoreDefaults(): Promise<void> {
    const defaults = defaultPresets();
    for (const g of [...new Set(defaults.map((p) => p.group!))].reverse())
      if (!this.#groups.includes(g)) this.#groups.unshift(g);
    await this.savePresets(defaults);
    await this.#saveOrder(true);
  }

  /** Remembers that a preset was used (for Recent Brushes). */
  markUsed(id: string): void {
    if (!this.#presets.has(id)) return;
    this.#recent = [id, ...this.#recent.filter((r) => r !== id)].slice(0, RECENT);
    this.#changed();
    void this.#saveOrder();
  }

  async #saveOrder(defaultsAdded?: boolean): Promise<void> {
    const before = await this.#meta.get('brushes');
    await this.#meta.put(
      { groups: this.groups(), recent: this.#recent, defaultsAdded: defaultsAdded ?? before?.defaultsAdded ?? false },
      'brushes',
    );
  }

  /** Calls `listener` when tips or presets change; returns an unsubscribe. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const l of this.#listeners) l();
  }
}
