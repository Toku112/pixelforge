/**
 * Tile memory manager: the app's "scratch disk".
 *
 * - Allocates tile memory as SharedArrayBuffer when the page is cross-origin
 *   isolated, so workers can process tiles in place.
 * - Accounts for the memory of every tile and enforces a budget (default 60 % of the
 *   device memory estimate; Preferences > Performance will expose it).
 * - When over budget, moves tiles that no open document is using (undo data,
 *   history snapshots) to a swap backend — OPFS in the browser — oldest first, and
 *   loads them back on demand via `ensureResident` (called by the history before
 *   undo/redo). Tiles of open documents are never evicted, so rendering and
 *   editing never wait on disk.
 */
import type { Tile, TileMemory, TileResidency } from '../../core/document/tile';

/** Where evicted tile bytes are kept. */
export interface SwapBackend {
  /** Saves bytes and returns a handle for loading them back. */
  store(bytes: Uint8Array): Promise<number>;
  /** Loads the bytes saved under `handle`. */
  load(handle: number): Promise<Uint8Array>;
  /** Forgets the bytes saved under `handle`. */
  free(handle: number): void;
}

/** Swap backend that keeps evicted bytes in ordinary memory (tests, or when OPFS is unavailable). */
export class MemorySwapBackend implements SwapBackend {
  readonly #slots = new Map<number, Uint8Array>();
  #next = 1;

  store(bytes: Uint8Array): Promise<number> {
    const handle = this.#next++;
    this.#slots.set(handle, bytes.slice());
    return Promise.resolve(handle);
  }

  load(handle: number): Promise<Uint8Array> {
    const bytes = this.#slots.get(handle);
    if (!bytes) return Promise.reject(new Error(`No swapped tile ${handle}`));
    return Promise.resolve(bytes.slice());
  }

  free(handle: number): void {
    this.#slots.delete(handle);
  }

  get size(): number {
    return this.#slots.size;
  }
}

export interface TileStoreOptions {
  /** Memory budget in bytes (default: `defaultMemoryBudget()`). */
  budgetBytes?: number;
  /** Where evicted tiles go. `null` disables eviction (no scratch disk available). */
  swap: SwapBackend | null;
  /** Allocate SharedArrayBuffer memory (default: when the page is cross-origin isolated). */
  shared?: boolean;
  /** Run budget enforcement automatically after allocations (default true). */
  autoEnforce?: boolean;
}

export interface TileStoreStats {
  budgetBytes: number;
  residentBytes: number;
  swappedBytes: number;
  residentTiles: number;
  swappedTiles: number;
  evictions: number;
  /** Evictions that failed (tile kept in memory). */
  evictionErrors: number;
  reloads: number;
}

interface Record {
  readonly ref: WeakRef<Tile>;
  readonly bytes: number;
  handle: number | null;
  evicting: boolean;
  loading: Promise<void> | null;
}

/** 60 % of the device memory estimate (navigator.deviceMemory, assumed 4 GB if unknown). */
export function defaultMemoryBudget(deviceMemoryGb?: number): number {
  const gb = deviceMemoryGb ?? 4;
  return Math.floor(gb * 0.6 * 1024 ** 3);
}

function canShareMemory(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  );
}

export class TileStore implements TileMemory, TileResidency {
  budgetBytes: number;
  readonly shared: boolean;
  readonly #swap: SwapBackend | null;
  readonly #autoEnforce: boolean;
  /** Insertion order = allocation order, so iteration visits the oldest tiles first. */
  readonly #records = new Map<number, Record>();
  readonly #finalizer: FinalizationRegistry<number>;
  #residentBytes = 0;
  #swappedBytes = 0;
  #evictions = 0;
  #evictionErrors = 0;
  #reloads = 0;
  #enforcing: Promise<void> | null = null;
  #enforceScheduled = false;

  constructor(options: TileStoreOptions) {
    this.budgetBytes = options.budgetBytes ?? defaultMemoryBudget();
    this.shared = options.shared ?? canShareMemory();
    this.#swap = options.swap;
    this.#autoEnforce = options.autoEnforce ?? true;
    // When a tile is garbage-collected, give back its accounting and swap slot.
    this.#finalizer = new FinalizationRegistry((id) => this.#forget(id));
  }

  // --- TileMemory ------------------------------------------------------------

  allocate(byteLength: number): ArrayBuffer | SharedArrayBuffer {
    return this.shared ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength);
  }

  /** False when there is no scratch disk: the budget is then informational only. */
  get canEvict(): boolean {
    return this.#swap !== null;
  }

  track(tile: Tile): void {
    this.#records.set(tile.id, {
      ref: new WeakRef(tile),
      bytes: tile.byteLength,
      handle: null,
      evicting: false,
      loading: null,
    });
    this.#finalizer.register(tile, tile.id);
    this.#residentBytes += tile.byteLength;
    if (this.#autoEnforce && this.#swap && this.#residentBytes > this.budgetBytes) this.#scheduleEnforce();
  }

  // --- TileResidency ---------------------------------------------------------

  async ensureResident(tiles: Iterable<Tile>): Promise<void> {
    const loads: Promise<void>[] = [];
    for (const tile of tiles) {
      if (tile.resident) continue;
      const record = this.#records.get(tile.id);
      if (!record) throw new Error(`Tile ${tile.id} is not managed by this store`);
      record.loading ??= this.#reload(tile, record).finally(() => (record.loading = null));
      loads.push(record.loading);
    }
    await Promise.all(loads);
  }

  // --- Budget ----------------------------------------------------------------

  /**
   * Evicts unused tiles, oldest first, until resident memory is back under 90 % of
   * the budget (or nothing more can be evicted). Concurrent calls share one run.
   */
  enforceBudget(): Promise<void> {
    this.#enforcing ??= this.#enforce().finally(() => (this.#enforcing = null));
    return this.#enforcing;
  }

  get stats(): TileStoreStats {
    let residentTiles = 0;
    let swappedTiles = 0;
    for (const record of this.#records.values()) {
      if (record.handle === null) residentTiles++;
      else swappedTiles++;
    }
    return {
      budgetBytes: this.budgetBytes,
      residentBytes: this.#residentBytes,
      swappedBytes: this.#swappedBytes,
      residentTiles,
      swappedTiles,
      evictions: this.#evictions,
      evictionErrors: this.#evictionErrors,
      reloads: this.#reloads,
    };
  }

  // ---------------------------------------------------------------------------

  #scheduleEnforce(): void {
    if (this.#enforceScheduled) return;
    this.#enforceScheduled = true;
    setTimeout(() => {
      this.#enforceScheduled = false;
      this.enforceBudget().catch((e: unknown) => console.error('Tile eviction failed', e));
    }, 0);
  }

  async #enforce(): Promise<void> {
    const swap = this.#swap;
    if (!swap) return;
    const target = this.budgetBytes * 0.9;
    for (const [id, record] of this.#records) {
      if (this.#residentBytes <= target) return;
      const tile = record.ref.deref();
      if (!tile) {
        this.#forget(id);
        continue;
      }
      if (!evictable(tile) || record.evicting || record.loading) continue;
      try {
        await this.#evict(tile, record, swap);
      } catch (error) {
        // Nothing is lost: the tile stays in memory. Try again on the next round.
        this.#evictionErrors++;
        console.warn('Could not move a tile to the scratch disk; keeping it in memory.', error);
        return;
      }
    }
  }

  async #evict(tile: Tile, record: Record, swap: SwapBackend): Promise<void> {
    record.evicting = true;
    try {
      const data = tile.data;
      const handle = await swap.store(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      // The tile may have been put back into a document while it was being written.
      if (!evictable(tile) || !this.#records.has(tile.id)) {
        swap.free(handle);
        return;
      }
      tile.release();
      record.handle = handle;
      this.#residentBytes -= record.bytes;
      this.#swappedBytes += record.bytes;
      this.#evictions++;
    } finally {
      record.evicting = false;
    }
  }

  async #reload(tile: Tile, record: Record): Promise<void> {
    const handle = record.handle;
    if (handle === null || !this.#swap) throw new Error(`Tile ${tile.id} has no swap copy`);
    const bytes = await this.#swap.load(handle);
    if (bytes.byteLength !== record.bytes) throw new Error(`Tile ${tile.id}: swapped size mismatch`);
    const buffer = this.allocate(record.bytes);
    new Uint8Array(buffer).set(bytes);
    tile.restore(buffer);
    this.#swap.free(handle);
    record.handle = null;
    this.#swappedBytes -= record.bytes;
    this.#residentBytes += record.bytes;
    this.#reloads++;
    if (this.#autoEnforce && this.#residentBytes > this.budgetBytes) this.#scheduleEnforce();
  }

  #forget(id: number): void {
    const record = this.#records.get(id);
    if (!record) return;
    this.#records.delete(id);
    if (record.handle === null) {
      this.#residentBytes -= record.bytes;
    } else {
      this.#swap?.free(record.handle);
      this.#swappedBytes -= record.bytes;
    }
  }
}

function evictable(tile: Tile): boolean {
  return tile.resident && tile.frozen && tile.attachedRefs === 0;
}
