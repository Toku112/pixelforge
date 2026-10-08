/**
 * The user's library in IndexedDB (CLAUDE.md §2: presets in IndexedDB): brush tips,
 * brush presets, patterns, tool presets and small values (orders, recent brushes).
 * Where storage is unavailable (a private window, tests) the libraries work for the
 * session only.
 */

const DB_NAME = 'pixelforge-library';
/** 1: brush tips; 2: presets, patterns, tool presets and values. */
const VERSION = 2;

export type LibraryStore = 'brushTips' | 'brushPresets' | 'patterns' | 'toolPresets' | 'meta';
const KEYED: LibraryStore[] = ['brushTips', 'brushPresets', 'patterns', 'toolPresets'];

export function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

let opened: Promise<IDBDatabase | null> | null = null;

/** The library database (opened once), or null without storage. */
export function openLibraryDb(): Promise<IDBDatabase | null> {
  opened ??= (async () => {
    if (typeof indexedDB === 'undefined') return null;
    try {
      const open = indexedDB.open(DB_NAME, VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        for (const store of KEYED)
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      return await request(open);
    } catch {
      return null;
    }
  })();
  return opened;
}

/** A store of the library: read everything, write and delete items (failures leave the session copy). */
export class LibraryStoreAccess<T> {
  readonly #store: LibraryStore;
  readonly #db: Promise<IDBDatabase | null>;

  constructor(store: LibraryStore, persist: boolean) {
    this.#store = store;
    this.#db = persist ? openLibraryDb() : Promise.resolve(null);
  }

  async all(): Promise<T[]> {
    const db = await this.#db;
    if (!db) return [];
    try {
      return await request(db.transaction(this.#store).objectStore(this.#store).getAll() as IDBRequest<T[]>);
    } catch {
      return [];
    }
  }

  async get(key: string): Promise<T | undefined> {
    const db = await this.#db;
    if (!db) return undefined;
    try {
      return await request(db.transaction(this.#store).objectStore(this.#store).get(key) as IDBRequest<T | undefined>);
    } catch {
      return undefined;
    }
  }

  async put(value: T, key?: string): Promise<void> {
    const db = await this.#db;
    if (!db) return;
    try {
      const store = db.transaction(this.#store, 'readwrite').objectStore(this.#store);
      await request(key === undefined ? store.put(value) : store.put(value, key));
    } catch {
      // Not saved: it stays for this session.
    }
  }

  async delete(key: string): Promise<void> {
    const db = await this.#db;
    if (!db) return;
    try {
      await request(db.transaction(this.#store, 'readwrite').objectStore(this.#store).delete(key));
    } catch {
      // Ignored: it is gone for this session.
    }
  }
}
