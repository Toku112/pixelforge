/**
 * Edit > Preferences: the user's settings, kept in IndexedDB (CLAUDE.md §2) so they
 * are there next time. Until the saved values load — or where storage is blocked —
 * the defaults apply. Pages so far: Tools (Overscroll, the brush HUD) and Cursors.
 */
import type { RGB } from '../core/color/color';
import { Emitter } from '../core/document/events';
import { DEFAULT_CURSOR_PREFERENCES, type CursorPreferences, type PaintCursor } from '../tools/types';

export interface PreferenceValues {
  cursors: CursorPreferences;
  /** Tools: the view may scroll the image past the window's edges. */
  overscroll: boolean;
}

export const DEFAULT_PREFERENCES: PreferenceValues = {
  cursors: DEFAULT_CURSOR_PREFERENCES,
  overscroll: false,
};

const DB_NAME = 'pixelforge-settings';
const STORE = 'preferences';
const KEY = 'values';

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
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    return await request(open);
  } catch {
    return null; // storage blocked: the defaults for this session
  }
}

const PAINT_CURSORS: readonly PaintCursor[] = ['standard', 'precise', 'normal', 'full'];

/** Saved (possibly old or damaged) values, completed with the defaults. */
export function sanitizePreferences(raw: unknown): PreferenceValues {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const c = (typeof r['cursors'] === 'object' && r['cursors'] !== null ? r['cursors'] : {}) as Record<string, unknown>;
  const D = DEFAULT_CURSOR_PREFERENCES;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const color = c['previewColor'] as Partial<RGB> | undefined;
  const validColor =
    color !== undefined &&
    [color.r, color.g, color.b].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1);
  return {
    cursors: {
      painting: PAINT_CURSORS.includes(c['painting'] as PaintCursor) ? (c['painting'] as PaintCursor) : D.painting,
      crosshairInTip: bool(c['crosshairInTip'], D.crosshairInTip),
      crosshairWhilePainting: bool(c['crosshairWhilePainting'], D.crosshairWhilePainting),
      hudHardness: bool(c['hudHardness'], D.hudHardness),
      previewColor: validColor ? { r: color.r!, g: color.g!, b: color.b! } : D.previewColor,
    },
    overscroll: bool(r['overscroll'], DEFAULT_PREFERENCES.overscroll),
  };
}

export class Preferences {
  readonly changes = new Emitter<void>();
  #values: PreferenceValues = DEFAULT_PREFERENCES;
  #version = 0;
  /** The last save, settled once written. */
  #saving: Promise<void> = Promise.resolve();
  readonly #db: Promise<IDBDatabase | null>;
  /** Settles once the saved values are loaded. */
  readonly ready: Promise<void>;

  constructor(persist = true) {
    this.#db = persist ? openDb() : Promise.resolve(null);
    this.ready = this.#load();
  }

  async #load(): Promise<void> {
    const db = await this.#db;
    if (!db) return;
    try {
      const saved: unknown = await request(db.transaction(STORE).objectStore(STORE).get(KEY) as IDBRequest<unknown>);
      if (saved !== undefined && this.#version === 0) this.#apply(sanitizePreferences(saved));
    } catch {
      // Unreadable: keep the defaults.
    }
  }

  get values(): PreferenceValues {
    return this.#values;
  }

  /** Increases with every change (for UI subscriptions). */
  get version(): number {
    return this.#version;
  }

  /** Changes the preferences (at once) and saves them. */
  set(values: PreferenceValues): Promise<void> {
    const clean = sanitizePreferences(values);
    this.#apply(clean);
    this.#saving = this.#saving.then(() => this.#save(clean));
    return this.#saving;
  }

  /** Settles when every change so far is saved. */
  saved(): Promise<void> {
    return this.#saving;
  }

  async #save(values: PreferenceValues): Promise<void> {
    const db = await this.#db;
    if (!db) return;
    try {
      await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(values, KEY));
    } catch {
      // Not saved; they apply for this session.
    }
  }

  #apply(values: PreferenceValues): void {
    this.#values = values;
    this.#version++;
    this.changes.emit();
  }
}
