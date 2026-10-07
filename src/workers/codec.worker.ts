/**
 * Codec worker: decodes image files into tiles and flattens/encodes documents for
 * saving, so no pixel work happens on the main thread.
 */
import { TILE_PIXELS, TILE_SIZE } from '../core/document/tile';
import { compositeToSamples, flatten, isOpaque, type FlattenPlan } from '../core/composite/flatten';
import init, * as codecs from '../wasm/pkg/codecs-st/codecs.js';
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

export type CodecWorkerApi = typeof api;

exposeApi(api);
