/**
 * The user's sampled brush tips (Edit > Define Brush Preset), kept in IndexedDB so
 * they are still there next time (CLAUDE.md §2: presets in IndexedDB). Where storage
 * is unavailable (a private window, tests) the tips live for the session only.
 */
import type { BrushTipSource } from '../core/commands/command';
import type { BrushTip } from '../core/paint/brush';

const DB_NAME = 'pixelforge-library';
const STORE = 'brushTips';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

async function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    return await request(open);
  } catch {
    return null; // e.g. storage blocked: keep tips in memory
  }
}

export class BrushLibrary implements BrushTipSource {
  readonly #tips = new Map<string, BrushTip>();
  readonly #listeners = new Set<() => void>();
  readonly #db: Promise<IDBDatabase | null>;
  /** Settles once the saved tips are loaded. */
  readonly ready: Promise<void>;

  constructor(persist = true) {
    this.#db = persist ? openDb() : Promise.resolve(null);
    this.ready = this.#load();
  }

  async #load(): Promise<void> {
    const db = await this.#db;
    if (!db) return;
    try {
      const all = await request(db.transaction(STORE).objectStore(STORE).getAll() as IDBRequest<BrushTip[]>);
      for (const tip of all) if (!this.#tips.has(tip.id)) this.#tips.set(tip.id, tip);
      this.#changed();
    } catch {
      // Unreadable storage: start empty.
    }
  }

  get(id: string): BrushTip | undefined {
    return this.#tips.get(id);
  }

  /** Every tip, oldest first. */
  list(): BrushTip[] {
    return [...this.#tips.values()];
  }

  /** Adds (or replaces) a tip and saves it. */
  async add(tip: BrushTip): Promise<void> {
    this.#tips.set(tip.id, tip);
    this.#changed();
    const db = await this.#db;
    if (!db) return;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      await request(tx.objectStore(STORE).put(tip));
    } catch {
      // Not saved; it stays for this session.
    }
  }

  async remove(id: string): Promise<void> {
    if (!this.#tips.delete(id)) return;
    this.#changed();
    const db = await this.#db;
    if (!db) return;
    try {
      await request(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
    } catch {
      // Ignored: the tip is gone for this session.
    }
  }

  /** Calls `listener` when tips are added or removed; returns an unsubscribe. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const l of this.#listeners) l();
  }
}
