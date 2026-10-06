/**
 * Swap worker: keeps evicted tile bytes in the Origin Private File System, the
 * app's scratch disk. Uses synchronous access handles (fast, worker-only).
 *
 * Tiles of the same byte size share one file (`<size>.bin`) divided into fixed
 * slots, with freed slots reused. Each tab writes into its own session folder and
 * holds a Web Lock named after it; on start-up, folders whose lock is free belong
 * to tabs that closed or crashed, and are deleted.
 */
import { exposeApi, transfer } from './rpc';

const SWAP_DIR = 'swap';
const LOCK_PREFIX = 'pixelforge-swap-';

interface SizeClass {
  size: number;
  file: FileSystemSyncAccessHandle;
  free: number[];
  next: number;
}

export interface SwapStats {
  session: string;
  files: number;
  slotsInUse: number;
  bytesOnDisk: number;
}

const session = crypto.randomUUID();
const classes = new Map<number, SizeClass>();
const handles = new Map<number, { cls: SizeClass; slot: number }>();
let nextHandle = 1;

async function holdSessionLock(): Promise<void> {
  await new Promise<void>((acquired) => {
    void navigator.locks.request(LOCK_PREFIX + session, () => {
      acquired();
      return new Promise<never>(() => {}); // held for the worker's lifetime
    });
  });
}

async function init(): Promise<FileSystemDirectoryHandle> {
  await holdSessionLock();
  const root = await navigator.storage.getDirectory();
  const swapRoot = await root.getDirectoryHandle(SWAP_DIR, { create: true });
  const stale: string[] = [];
  for await (const name of swapRoot.keys()) if (name !== session) stale.push(name);
  for (const name of stale) {
    await navigator.locks.request(LOCK_PREFIX + name, { ifAvailable: true }, async (lock) => {
      if (lock) await swapRoot.removeEntry(name, { recursive: true });
    });
  }
  return swapRoot.getDirectoryHandle(session, { create: true });
}

const ready = init();

async function sizeClass(size: number): Promise<SizeClass> {
  let cls = classes.get(size);
  if (!cls) {
    const dir = await ready;
    const fileHandle = await dir.getFileHandle(`${size}.bin`, { create: true });
    cls = { size, file: await fileHandle.createSyncAccessHandle(), free: [], next: 0 };
    classes.set(size, cls);
  }
  return cls;
}

const api = {
  async store(bytes: Uint8Array): Promise<number> {
    const cls = await sizeClass(bytes.byteLength);
    const slot = cls.free.pop() ?? cls.next++;
    const written = cls.file.write(bytes, { at: slot * cls.size });
    if (written !== cls.size) {
      cls.free.push(slot);
      throw new Error(`Scratch disk write failed (${written} of ${cls.size} bytes); storage may be full`);
    }
    const handle = nextHandle++;
    handles.set(handle, { cls, slot });
    return handle;
  },

  load(handle: number): Uint8Array {
    const entry = handles.get(handle);
    if (!entry) throw new Error(`No swapped tile ${handle}`);
    const out = new Uint8Array(entry.cls.size);
    const read = entry.cls.file.read(out, { at: entry.slot * entry.cls.size });
    if (read !== entry.cls.size) throw new Error(`Scratch disk read failed (${read} of ${entry.cls.size} bytes)`);
    return transfer(out, [out.buffer]);
  },

  free(handle: number): void {
    const entry = handles.get(handle);
    if (!entry) return;
    handles.delete(handle);
    entry.cls.free.push(entry.slot);
  },

  async stats(): Promise<SwapStats> {
    await ready;
    let bytesOnDisk = 0;
    for (const cls of classes.values()) bytesOnDisk += cls.file.getSize();
    return { session, files: classes.size, slotsInUse: handles.size, bytesOnDisk };
  },

  /** Closes the files and deletes this session's folder. */
  async dispose(): Promise<void> {
    const dir = await ready;
    for (const cls of classes.values()) cls.file.close();
    classes.clear();
    handles.clear();
    const root = await navigator.storage.getDirectory();
    const swapRoot = await root.getDirectoryHandle(SWAP_DIR);
    await swapRoot.removeEntry(dir.name, { recursive: true });
  },
};

export type SwapWorkerApi = typeof api;

exposeApi(api);
