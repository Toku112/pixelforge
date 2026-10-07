// Test-only page: opening, saving and drag-and-drop through the real codec worker.
import { registerBuiltinCommands } from '../../../src/core/commands/builtin';
import { CommandRegistry } from '../../../src/core/commands/registry';
import type { ImageDocument } from '../../../src/core/document/document';
import { TileStore } from '../../../src/engine/tiles/tile-store';
import { installFileDrop } from '../../../src/io/drop';
import { download, pickFiles, saveFileAs } from '../../../src/io/file-access';
import { openAcceptTypes } from '../../../src/io/formats';
import { openImage as openFile } from '../../../src/io/open-image';
import { encodeDocumentAsPng } from '../../../src/io/save-png';
import { createCodecWorker } from '../../../src/workers/codec-client';
import { createPixelWorker } from '../../../src/workers/pixel-client';
import { createWorkerPixelOps } from '../../../src/workers/pixel-ops-client';

/** Opens a file as a document (simplification notes are not needed here). */
const openImage = async (...args: Parameters<typeof openFile>) => (await openFile(...args)).doc;

const fixtureUrls = import.meta.glob<string>('../../fixtures/images/*', {
  query: '?url',
  import: 'default',
  eager: true,
});
async function fixture(name: string): Promise<Uint8Array> {
  const url = fixtureUrls[`../../fixtures/images/${name}`];
  if (!url) throw new Error(`No fixture ${name}`);
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

const codec = createCodecWorker();
const store = new TileStore({ swap: null });
const options = { memory: store, shared: store.shared };

function summary(doc: ImageDocument, probes: [number, number][] = [[0, 0]]) {
  const layer = doc.requirePixelLayer(doc.activeLayerId!);
  return {
    name: doc.name,
    width: doc.width,
    height: doc.height,
    mode: doc.mode,
    depth: doc.depth,
    resolution: doc.resolution,
    layerName: layer.name,
    isBackground: layer.isBackground,
    tileCount: layer.buffer.tileCount,
    shared: [...layer.buffer.tiles()].every(([, , t]) => t.data.buffer instanceof SharedArrayBuffer),
    iccBytes: doc.iccProfile?.length ?? 0,
    pixels: probes.map(([x, y]) => layer.buffer.getPixel(x, y)),
  };
}

const harness = {
  async open(name: string, probes?: [number, number][]) {
    return summary(await openImage(await fixture(name), name, codec, options), probes);
  },

  async openGarbage() {
    try {
      await openFile(new Uint8Array([1, 2, 3, 4]), 'notes.txt', codec, options);
      return 'opened';
    } catch (e) {
      return (e as Error).message;
    }
  },

  /** Opens, saves as PNG, then reopens the saved bytes. */
  async saveAndReopen(name: string, probes?: [number, number][]) {
    const doc = await openImage(await fixture(name), name, codec, options);
    const png = await encodeDocumentAsPng(doc, codec);
    return {
      original: summary(doc, probes),
      reopened: summary(await openImage(png, 'saved.png', codec, options), probes),
    };
  },

  async invertThenSave() {
    const doc = await openImage(await fixture('rgb8.png'), 'rgb8.png', codec, options);
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const ctx = { doc, services: { pixelOps: createWorkerPixelOps(createPixelWorker()) } };
    const before = doc.requirePixelLayer(doc.activeLayerId!).buffer.getPixel(10, 10);
    await registry.create(ctx, { name: 'invert', params: {} }).execute();
    const png = await encodeDocumentAsPng(doc, codec);
    const reopened = await openImage(png, 'inverted.png', codec, options);
    return { before, after: reopened.requirePixelLayer(reopened.activeLayerId!).buffer.getPixel(10, 10) };
  },

  async saveRestriction() {
    const doc = await openImage(await fixture('rgb8.png'), 'rgb8.png', codec, options);
    doc.removeLayer(doc.activeLayerId!);
    doc.setCanvasProps({ depth: 32 });
    try {
      await encodeDocumentAsPng(doc, codec);
      return 'saved';
    } catch (e) {
      return (e as Error).message;
    }
  },

  /** Simulates dropping a fixture file on the drop target. */
  async drop(name: string) {
    const target = document.getElementById('drop-target')!;
    const received: string[] = [];
    const states: boolean[] = [];
    const off = installFileDrop(
      target,
      (files) => received.push(...files.map((f) => f.name)),
      (a) => states.push(a),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([(await fixture(name)) as Uint8Array<ArrayBuffer>], name, { type: 'image/png' }));
    for (const type of ['dragenter', 'dragover', 'drop'] as const) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }
    off();
    return { received, states };
  },

  /** Open dialog via the hidden-input fallback (native dialogs disabled). */
  async pickWithFallback() {
    (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker = undefined;
    const files = await pickFiles(openAcceptTypes());
    return files.map((f) => ({ name: f.name, size: f.bytes.length }));
  },

  /** Save via the download fallback (native dialogs disabled). */
  async saveWithFallback() {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
    return saveFileAs(new Uint8Array([1, 2, 3]), 'picture.png', 'image/png', '.png', 'PNG');
  },

  download: () => download(new Uint8Array([9, 9]), 'direct.png', 'image/png'),
};

declare global {
  interface Window {
    __io?: typeof harness;
  }
}
window.__io = harness;
