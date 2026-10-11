/**
 * File > New's own lists, kept in IndexedDB: the document presets the user saved and
 * the settings of recently made documents (newest first).
 */
import {
  sameSettings,
  sanitizePresets,
  type DocumentPreset,
  type NewDocumentSettings,
} from '../core/document/new-document';
import { LibraryStoreAccess } from './library-db';

/** How many recent documents the Recent category keeps. */
export const RECENT_DOCUMENTS = 20;

export class DocumentPresetLibrary {
  #saved: DocumentPreset[] = [];
  #recent: DocumentPreset[] = [];
  readonly #meta: LibraryStoreAccess<unknown>;
  readonly ready: Promise<void>;

  constructor(persist = true) {
    this.#meta = new LibraryStoreAccess('meta', persist);
    this.ready = Promise.all([this.#meta.get('documentPresets'), this.#meta.get('recentDocuments')]).then(
      ([saved, recent]) => {
        // Changes made before loading finished win.
        if (this.#saved.length === 0) this.#saved = sanitizePresets(saved);
        if (this.#recent.length === 0) this.#recent = sanitizePresets(recent);
      },
    );
  }

  saved(): readonly DocumentPreset[] {
    return this.#saved;
  }

  recent(): readonly DocumentPreset[] {
    return this.#recent;
  }

  /** Saves a preset (one of the same name is replaced). */
  async save(preset: DocumentPreset): Promise<void> {
    this.#saved = [...this.#saved.filter((p) => p.name !== preset.name), preset];
    await this.#meta.put(this.#saved, 'documentPresets');
  }

  async deleteSaved(id: string): Promise<void> {
    this.#saved = this.#saved.filter((p) => p.id !== id);
    await this.#meta.put(this.#saved, 'documentPresets');
  }

  /** Puts a document's settings first in Recent (the same settings move up instead of repeating). */
  async addRecent(preset: DocumentPreset): Promise<void> {
    this.#recent = [preset, ...this.#recent.filter((p) => !sameSettings(p.settings, preset.settings))].slice(
      0,
      RECENT_DOCUMENTS,
    );
    await this.#meta.put(this.#recent, 'recentDocuments');
  }

  /** The settings the dialog opens with: the last document made, or null. */
  last(): NewDocumentSettings | null {
    return this.#recent[0]?.settings ?? null;
  }
}
