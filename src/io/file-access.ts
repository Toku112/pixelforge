/**
 * Opening and saving files in the browser.
 *
 * Uses the File System Access API where available (Chromium): native open/save
 * dialogs, and Save can write back to the same file. Elsewhere it falls back to a
 * hidden file input for opening and a download for saving.
 */

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
  /** Present when opened through the File System Access API; allows saving in place. */
  handle?: FileSystemFileHandle;
}

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

/** File System Access API dialogs (not yet in TypeScript's DOM types). Must be called with `window` as `this`. */
interface FsAccessWindow {
  showOpenFilePicker?: (options: {
    multiple?: boolean;
    types?: FilePickerAcceptType[];
    excludeAcceptAllOption?: boolean;
  }) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: FilePickerAcceptType[];
  }) => Promise<FileSystemFileHandle>;
}

const fsWindow = () => window as unknown as FsAccessWindow;

export function hasNativeFileDialogs(): boolean {
  return typeof fsWindow().showOpenFilePicker === 'function' && typeof fsWindow().showSaveFilePicker === 'function';
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function readFile(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** Shows an Open dialog. Resolves to an empty list if the user cancels. */
export async function pickFiles(accept: Record<string, string[]>, description = 'Images'): Promise<PickedFile[]> {
  const picker = fsWindow().showOpenFilePicker;
  if (picker) {
    try {
      const handles = await picker.call(window, { multiple: true, types: [{ description, accept }] });
      return Promise.all(
        handles.map(async (handle) => {
          const file = await handle.getFile();
          return { name: file.name, bytes: await readFile(file), handle };
        }),
      );
    } catch (error) {
      if (isAbort(error)) return [];
      throw error;
    }
  }
  return pickWithInput(Object.values(accept).flat());
}

function pickWithInput(extensions: string[]): Promise<PickedFile[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = extensions.join(',');
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      input.remove();
      Promise.all(files.map(async (file) => ({ name: file.name, bytes: await readFile(file) }))).then(resolve, reject);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve([]);
    });
    document.body.append(input);
    input.click();
  });
}

export type SaveOutcome =
  | { kind: 'saved'; handle: FileSystemFileHandle; name: string }
  | { kind: 'downloaded'; name: string }
  | { kind: 'cancelled' };

/** Shows a Save dialog (or downloads the file when native dialogs are unavailable). */
export async function saveFileAs(
  bytes: Uint8Array,
  suggestedName: string,
  mimeType: string,
  extension: string,
  description: string,
): Promise<SaveOutcome> {
  const picker = fsWindow().showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker.call(window, {
        suggestedName,
        types: [{ description, accept: { [mimeType]: [extension] } }],
      });
      await writeToHandle(handle, bytes);
      return { kind: 'saved', handle, name: handle.name };
    } catch (error) {
      if (isAbort(error)) return { kind: 'cancelled' };
      throw error;
    }
  }
  download(bytes, suggestedName, mimeType);
  return { kind: 'downloaded', name: suggestedName };
}

/** Writes bytes to a file the user already chose (Save in place). */
export async function writeToHandle(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(bytes as Uint8Array<ArrayBuffer>);
  await writable.close();
}

export function download(bytes: Uint8Array, name: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
