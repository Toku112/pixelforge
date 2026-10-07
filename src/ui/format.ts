import type { ImageDocument } from '../core/document/document';
import type { ColorMode } from '../core/document/pixel-format';

/** Zoom as shown in tabs and the status bar: "33.33%", "66.7%", "100%", "1600%". */
export function formatZoom(zoom: number): string {
  const pct = zoom * 100;
  const digits = pct < 10 ? 2 : pct < 100 ? 2 : 1;
  return `${Number(pct.toFixed(digits))}%`;
}

const MODE_LABELS: Record<ColorMode, string> = {
  bitmap: 'Bitmap',
  grayscale: 'Gray',
  duotone: 'Duotone',
  indexed: 'Index',
  rgb: 'RGB',
  cmyk: 'CMYK',
  lab: 'Lab',
  multichannel: 'Multichannel',
};

export function modeLabel(doc: ImageDocument): string {
  return `${MODE_LABELS[doc.mode]}/${doc.depth}`;
}

/** Byte size as "512K", "23.4M", "1.2G". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))}K`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

/** Flattened size and an estimate of the layered size, as shown in "Document Sizes". */
export function documentSizes(doc: ImageDocument): { flattened: number; layered: number } {
  const bps = doc.depth === 8 ? 1 : doc.depth === 16 ? 2 : 4;
  const flattened = doc.width * doc.height * doc.colorChannels * bps;
  let layered = 0;
  for (const layer of doc.layers()) {
    if (layer.kind !== 'pixel') continue;
    const spp = layer.buffer.spp;
    const pixels =
      layer.buffer.tileCount > 0 ? layer.buffer.tileCount * 256 * 256 : layer.isBackground ? doc.width * doc.height : 0;
    layered += Math.min(pixels, doc.width * doc.height * 4) * spp * bps;
  }
  return { flattened, layered };
}
