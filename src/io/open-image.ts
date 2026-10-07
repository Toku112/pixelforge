/**
 * Opens an image file as a document.
 *
 * Behaviour (as in the reference app): an image without transparency opens as a
 * locked "Background" layer; an image with transparency opens as a normal layer
 * named "Layer 0". Grayscale files open in Grayscale mode, others in RGB; 16-bit
 * files open as 16-bit documents. The resolution comes from the file (72 ppi if it
 * has none) and an embedded ICC profile is kept for saving.
 */
import { ImageDocument } from '../core/document/document';
import { adoptTile, type TileMemory } from '../core/document/tile';
import type { CodecWorkerClient } from '../workers/codec-client';
import { detectFormat } from './formats';
import { openPsd, type OpenedDocument } from './psd';

export interface OpenOptions {
  memory: TileMemory;
  /** Ask the worker for SharedArrayBuffer tiles (when the page is cross-origin isolated). */
  shared: boolean;
}

export class UnsupportedFileError extends Error {
  override readonly name = 'UnsupportedFileError';
}

export async function openImage(
  bytes: Uint8Array,
  fileName: string,
  codec: CodecWorkerClient,
  options: OpenOptions,
): Promise<OpenedDocument> {
  const format = detectFormat(bytes);
  if (!format?.canOpen) throw new UnsupportedFileError(`“${fileName}” is not a PSD, PNG, JPEG or WebP file`);
  if (format.id === 'psd') return openPsd(bytes, fileName, codec, options);
  const decoded = await codec.decodeToTiles(bytes, { shared: options.shared });
  const gray = decoded.channels <= 2;
  const hasAlpha = decoded.channels === 2 || decoded.channels === 4;
  const doc = new ImageDocument({
    width: decoded.width,
    height: decoded.height,
    name: fileName,
    mode: gray ? 'grayscale' : 'rgb',
    depth: decoded.depth,
    resolution: decoded.ppi > 0 ? Math.round(decoded.ppi * 1000) / 1000 : 72,
    memory: options.memory,
  });
  doc.iccProfile = decoded.iccProfile;
  const layer = hasAlpha ? doc.createPixelLayer('Layer 0') : doc.createBackgroundLayer();
  for (const t of decoded.tiles)
    layer.buffer.setTile(t.tx, t.ty, adoptTile(t.data, layer.buffer.format, options.memory));
  doc.insertLayer(layer);
  doc.setActiveLayer(layer.id);
  return { doc, simplified: [] };
}
