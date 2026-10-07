/**
 * Layers-panel thumbnails, rendered in the pixel worker and cached per layer.
 *
 * A thumbnail is identified by the layer's pixel buffer, a counter of pixel
 * changes, its offset and the document/thumbnail size. `get()` returns the last
 * thumbnail at once (possibly out of date) and queues a refresh when that key
 * changed; refreshes run one at a time, so painting never floods the worker.
 */
import type { ThumbnailRenderer } from '../../../app/services';
import { thumbnailSize, type ThumbnailSource } from '../../../core/composite/thumbnail';
import type { ImageDocument } from '../../../core/document/document';
import type { PixelLayer } from '../../../core/document/layers';
import type { TiledBuffer } from '../../../core/document/tiled-buffer';

interface Entry {
  key: string;
  image: ImageData | null;
  /** Key of the refresh queued or running. */
  pending: string | null;
}

interface Job {
  doc: ImageDocument;
  layer: PixelLayer;
  entry: Entry;
  key: string;
  width: number;
  height: number;
}

interface DocState {
  entries: Map<string, Entry>;
  /** Pixel-change counters per layer id. */
  revisions: Map<string, number>;
}

let nextBufferId = 1;
const bufferIds = new WeakMap<TiledBuffer, number>();

function bufferId(buffer: TiledBuffer): number {
  let id = bufferIds.get(buffer);
  if (id === undefined) bufferIds.set(buffer, (id = nextBufferId++));
  return id;
}

export class ThumbnailCache {
  readonly #render: ThumbnailRenderer;
  readonly #docs = new WeakMap<ImageDocument, DocState>();
  readonly #listeners = new Set<() => void>();
  readonly #queue: Job[] = [];
  #running = false;
  #version = 0;
  #notifyScheduled = false;

  constructor(render: ThumbnailRenderer) {
    this.#render = render;
  }

  /** Increases whenever a thumbnail changes (for useSyncExternalStore). */
  get version(): number {
    return this.#version;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Thumbnail size (device pixels) for a document fitted in a `box` square. */
  size(doc: ImageDocument, box: number): { width: number; height: number } {
    return thumbnailSize(doc.width, doc.height, box);
  }

  /** The layer's current thumbnail (null until the first one is ready); queues a refresh if it is stale. */
  get(doc: ImageDocument, layer: PixelLayer, box: number): ImageData | null {
    const state = this.#state(doc);
    const { width, height } = this.size(doc, box);
    const rev = state.revisions.get(layer.id) ?? 0;
    const key = `${bufferId(layer.buffer)}:${rev}:${layer.offsetX},${layer.offsetY}:${doc.width}x${doc.height}:${width}x${height}`;
    let entry = state.entries.get(layer.id);
    if (!entry) state.entries.set(layer.id, (entry = { key: '', image: null, pending: null }));
    if (entry.key !== key && entry.pending !== key) {
      entry.pending = key;
      this.#queue.push({ doc, layer, entry, key, width, height });
      void this.#pump();
    }
    return entry.image;
  }

  #state(doc: ImageDocument): DocState {
    let state = this.#docs.get(doc);
    if (!state) {
      const created: DocState = { entries: new Map(), revisions: new Map() };
      doc.changes.on((change) => {
        if (change.kind !== 'pixels') return;
        created.revisions.set(change.layerId, (created.revisions.get(change.layerId) ?? 0) + 1);
        this.#notifySoon(); // the panel re-renders, sees the new key and queues a refresh
      });
      this.#docs.set(doc, (state = created));
    }
    return state;
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let job = this.#queue.shift(); job; job = this.#queue.shift()) {
        // Skip jobs superseded by a newer key, or for layers no longer in their document.
        if (job.entry.pending !== job.key) continue;
        if (job.doc.getLayer(job.layer.id) !== job.layer) {
          job.entry.pending = null;
          continue;
        }
        const source: ThumbnailSource = {
          format: job.layer.buffer.format,
          defaultPixel: job.layer.buffer.defaultPixel,
          tiles: [...job.layer.buffer.tiles()].map(([tx, ty, tile]) => ({ tx, ty, data: tile.data })),
          offsetX: job.layer.offsetX,
          offsetY: job.layer.offsetY,
        };
        let image: ImageData | null = null;
        try {
          const t = await this.#render(source, job.doc.canvasRect, job.width, job.height);
          image = new ImageData(new Uint8ClampedArray(t.data), t.width, t.height);
        } catch {
          // Unsupported colour mode: the row shows an empty thumbnail rather than retrying.
        }
        if (job.entry.pending === job.key) {
          job.entry.pending = null;
          job.entry.key = job.key;
          job.entry.image = image;
          this.#version++;
          this.#notify();
        }
      }
    } finally {
      this.#running = false;
    }
  }

  #notifySoon(): void {
    if (this.#notifyScheduled) return;
    this.#notifyScheduled = true;
    setTimeout(() => {
      this.#notifyScheduled = false;
      this.#version++;
      this.#notify();
    }, 100);
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
