/**
 * Codec worker: decodes image files into tiles and flattens/encodes documents for
 * saving, so no pixel work happens on the main thread.
 */
import { TILE_PIXELS, TILE_SIZE } from '../core/document/tile';
import { compositeToSamples, flatten, isOpaque, type FlattenPlan } from '../core/composite/flatten';
import init, * as codecs from '../wasm/pkg/codecs-st/codecs.js';
import { withIccProfile } from '../io/webp-riff';
import { readPsdFile, writePsdFile, type PsdFileData, type PsdNode, type PsdSaveData } from '../io/psd-format';
import { importAbr, type AbrImport } from '../io/abr';
import { readPat, writePat, type PatImport } from '../io/pat';
import type { Pattern } from '../core/pattern/pattern';
import { exposeApi, transfer } from './rpc';

const ready = init();

export interface DecodedTiles {
  format: string;
  width: number;
  height: number;
  /** 1 gray, 2 gray+alpha, 3 RGB, 4 RGBA. */
  channels: number;
  depth: 8 | 16;
  /** Pixels per inch, or 0 if the file has none. */
  ppi: number;
  iccProfile: Uint8Array | null;
  /** Tiles in the image's tile grid; fully transparent tiles are omitted. */
  tiles: { tx: number; ty: number; data: Uint8Array | Uint16Array }[];
}

/** Cuts interleaved samples into 256 × 256 tiles. Edge areas are padded with `pad`. */
function cutIntoTiles(
  data: Uint8Array | Uint16Array,
  width: number,
  height: number,
  channels: number,
  hasAlpha: boolean,
  shared: boolean,
): DecodedTiles['tiles'] {
  const max = data instanceof Uint8Array ? 255 : 65535;
  const pad = hasAlpha ? 0 : max; // transparent, or white for opaque images
  const tiles: DecodedTiles['tiles'] = [];
  const bytes = data.BYTES_PER_ELEMENT;
  for (let ty = 0; ty * TILE_SIZE < height; ty++) {
    for (let tx = 0; tx * TILE_SIZE < width; tx++) {
      const x0 = tx * TILE_SIZE;
      const y0 = ty * TILE_SIZE;
      const w = Math.min(TILE_SIZE, width - x0);
      const h = Math.min(TILE_SIZE, height - y0);
      if (hasAlpha && isTransparent(data, width, channels, x0, y0, w, h)) continue;
      const length = TILE_PIXELS * channels;
      const buffer = shared ? new SharedArrayBuffer(length * bytes) : new ArrayBuffer(length * bytes);
      const tile = data instanceof Uint8Array ? new Uint8Array(buffer) : new Uint16Array(buffer);
      if (pad !== 0 && (w < TILE_SIZE || h < TILE_SIZE)) tile.fill(pad);
      for (let y = 0; y < h; y++) {
        const src = ((y0 + y) * width + x0) * channels;
        (tile as Uint8Array).set(data.subarray(src, src + w * channels), y * TILE_SIZE * channels);
      }
      tiles.push({ tx, ty, data: tile });
    }
  }
  return tiles;
}

function isTransparent(
  data: Uint8Array | Uint16Array,
  width: number,
  channels: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): boolean {
  for (let y = y0; y < y0 + h; y++) {
    for (let i = (y * width + x0) * channels + channels - 1, end = i + w * channels; i < end; i += channels) {
      if (data[i] !== 0) return false;
    }
  }
  return true;
}

const api = {
  async decodeToTiles(bytes: Uint8Array, options: { shared: boolean }): Promise<DecodedTiles> {
    await ready;
    const image = codecs.decodeImage(bytes);
    try {
      const { width, height, channels } = image;
      const depth = image.depth === 16 ? 16 : 8;
      const data = depth === 16 ? image.takeData16() : image.takeData8();
      const hasAlpha = channels === 2 || channels === 4;
      const tiles = cutIntoTiles(data, width, height, channels, hasAlpha, options.shared);
      const result: DecodedTiles = {
        format: image.format,
        width,
        height,
        channels,
        depth,
        ppi: image.ppiX,
        iccProfile: image.iccProfile ?? null,
        tiles,
      };
      return options.shared
        ? result
        : transfer(
            result,
            tiles.map((t) => t.data.buffer as ArrayBuffer),
          );
    } finally {
      image.free();
    }
  },

  /** Flattens the visible layers and encodes a PNG (alpha only if the result has transparency). */
  async flattenToPng(
    plan: FlattenPlan,
    options: { ppi: number; iccProfile: Uint8Array | null; compression: number },
  ): Promise<Uint8Array> {
    await ready;
    if (plan.depth === 32) throw new Error('PNG cannot store 32-bit images');
    if (plan.colorChannels !== 1 && plan.colorChannels !== 3)
      throw new Error('PNG supports RGB and Grayscale images only');
    const composite = flatten(plan);
    const alpha = !isOpaque(composite);
    const samples = compositeToSamples(composite, plan.depth, alpha);
    const channels = plan.colorChannels + (alpha ? 1 : 0);
    const icc = options.iccProfile ?? undefined;
    const png =
      samples instanceof Uint8Array
        ? codecs.encodePng8(samples, plan.width, plan.height, channels, options.ppi, icc, options.compression)
        : codecs.encodePng16(samples, plan.width, plan.height, channels, options.ppi, icc, options.compression);
    return transfer(png, [png.buffer as ArrayBuffer]);
  },
};

function psdTileBuffers(nodes: PsdNode[]): ArrayBuffer[] {
  return nodes.flatMap((n) =>
    n.kind === 'group'
      ? psdTileBuffers(n.children)
      : n.tiles.filter((t) => !(t.data.buffer instanceof SharedArrayBuffer)).map((t) => t.data.buffer as ArrayBuffer),
  );
}

const psd = {
  /** Reads a PSD/PSB file into layer data with tiles (see io/psd-format.ts). */
  readPsd(bytes: Uint8Array, options: { shared: boolean }): PsdFileData {
    const data = readPsdFile(bytes, options.shared);
    return transfer(data, psdTileBuffers(data.layers));
  },

  /** Writes an 8-bit RGB PSD with layers and a flattened composite of `plan`. */
  writePsd(data: PsdSaveData, plan: FlattenPlan): Uint8Array {
    const composite = flatten(plan);
    const samples = compositeToSamples(composite, 8, true) as Uint8Array;
    const bytes = writePsdFile(data, {
      width: plan.width,
      height: plan.height,
      data: new Uint8ClampedArray(samples.buffer, samples.byteOffset, samples.byteLength),
    });
    return transfer(bytes, [bytes.buffer as ArrayBuffer]);
  },
};
Object.assign(api, psd);

const brushFiles = {
  /** Reads an .abr brush file into presets, tips and patterns (see io/abr.ts). */
  importAbr(bytes: Uint8Array, group: string, prefix: string): AbrImport {
    const result = importAbr(bytes, group, prefix);
    const buffers = new Set<ArrayBuffer>();
    for (const item of [...result.tips, ...result.patterns])
      if (!(item.data.buffer instanceof SharedArrayBuffer)) buffers.add(item.data.buffer);
    return transfer(result, [...buffers]);
  },
  /** Reads a .pat pattern file (see io/pat.ts). */
  importPat(bytes: Uint8Array): PatImport {
    const result = readPat(bytes);
    return transfer(
      result,
      result.patterns.map((p) => p.data.buffer as ArrayBuffer),
    );
  },
  /** Writes patterns as a .pat file. */
  exportPat(patterns: Pattern[]): Uint8Array {
    const bytes = writePat(patterns);
    return transfer(bytes, [bytes.buffer as ArrayBuffer]);
  },
};
Object.assign(api, brushFiles);

/** Replaces transparency with `matte` (colour 0–1): the composite becomes opaque. */
function overMatte(composite: { colorChannels: number; data: Float32Array }, matte: readonly number[]): void {
  const cc = composite.colorChannels;
  const stride = cc + 1;
  const d = composite.data;
  for (let i = 0; i < d.length; i += stride) {
    const a = d[i + cc]!;
    if (a >= 1) continue;
    for (let c = 0; c < cc; c++) d[i + c] = d[i + c]! + (matte[c] ?? 1) * (1 - a);
    d[i + cc] = 1;
  }
}

/** Flat formats hold 8-bit gray or RGB. */
function checkFlat(plan: FlattenPlan, format: string): void {
  if (plan.depth === 32) throw new Error(`${format} cannot store 32-bit images`);
  if (plan.colorChannels !== 1 && plan.colorChannels !== 3)
    throw new Error(`${format} supports RGB and Grayscale images only`);
}

const lossy = {
  /** Flattens over `matte` and encodes a JPEG (see io/jpeg-options.ts for the settings). */
  async flattenToJpeg(
    plan: FlattenPlan,
    options: {
      quality: number;
      subsample: boolean;
      mode: number;
      scans: number;
      matte: number[];
      ppi: number;
      iccProfile: Uint8Array | null;
    },
  ): Promise<Uint8Array> {
    await ready;
    checkFlat(plan, 'JPEG');
    const composite = flatten(plan);
    overMatte(composite, options.matte);
    const samples = compositeToSamples(composite, 8, false) as Uint8Array;
    const jpeg = codecs.encodeJpeg(
      samples,
      plan.width,
      plan.height,
      plan.colorChannels,
      options.quality,
      options.subsample,
      options.mode,
      options.scans,
      options.ppi,
      options.iccProfile ?? undefined,
    );
    return transfer(jpeg, [jpeg.buffer as ArrayBuffer]);
  },

  /** Flattens and encodes a lossless WebP (alpha only if the image has transparency). */
  async flattenToWebpLossless(plan: FlattenPlan, options: { iccProfile: Uint8Array | null }): Promise<Uint8Array> {
    await ready;
    checkFlat(plan, 'WebP');
    const composite = flatten(plan);
    const alpha = !isOpaque(composite);
    const samples = compositeToSamples(composite, 8, alpha) as Uint8Array;
    const webp = codecs.encodeWebpLossless(
      samples,
      plan.width,
      plan.height,
      plan.colorChannels + (alpha ? 1 : 0),
      options.iccProfile ?? undefined,
    );
    return transfer(webp, [webp.buffer as ArrayBuffer]);
  },
};
Object.assign(api, lossy);

/** Whether the browser can encode lossy WebP (Chromium and Firefox can; Safari makes PNG instead). */
async function browserEncodesWebp(): Promise<boolean> {
  if (typeof OffscreenCanvas === 'undefined') return false;
  try {
    const canvas = new OffscreenCanvas(1, 1);
    canvas.getContext('2d');
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.5 });
    return blob.type === 'image/webp';
  } catch {
    return false;
  }
}
let webpSupport: Promise<boolean> | null = null;

const browserWebp = {
  canEncodeLossyWebp(): Promise<boolean> {
    return (webpSupport ??= browserEncodesWebp());
  },

  /**
   * Flattens and encodes a lossy WebP with the browser's encoder (`quality` 0–1),
   * then embeds the ICC profile (the browser writes none).
   */
  async flattenToWebpLossy(
    plan: FlattenPlan,
    options: { quality: number; iccProfile: Uint8Array | null },
  ): Promise<Uint8Array> {
    if (!(await browserWebp.canEncodeLossyWebp())) throw new Error('This browser cannot make lossy WebP files');
    checkFlat(plan, 'WebP');
    const composite = flatten(plan);
    const samples = compositeToSamples(composite, 8, true) as Uint8Array;
    const { width, height } = plan;
    const rgba = new Uint8ClampedArray(width * height * 4);
    if (plan.colorChannels === 1) {
      for (let p = 0; p < width * height; p++) {
        const v = samples[p * 2]!;
        rgba.set([v, v, v, samples[p * 2 + 1]!], p * 4);
      }
    } else {
      rgba.set(samples);
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })!;
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: options.quality });
    let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
    if (options.iccProfile && options.iccProfile.length > 0)
      bytes = withIccProfile(bytes, options.iccProfile, width, height);
    return transfer(bytes, [bytes.buffer as ArrayBuffer]);
  },
};
Object.assign(api, browserWebp);

export type CodecWorkerApi = typeof api & typeof psd & typeof brushFiles & typeof lossy & typeof browserWebp;

exposeApi(api);
