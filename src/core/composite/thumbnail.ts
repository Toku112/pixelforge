/**
 * Layer thumbnails (Layers panel): a small sRGB picture of one layer's content
 * over a document area, with transparency kept.
 *
 * Each thumbnail pixel averages a grid of up to 4 × 4 samples spread over its
 * footprint in the document (premultiplied, so transparent areas do not darken
 * the result). That is far cheaper than averaging every pixel and looks smooth
 * at thumbnail sizes. 32-bit (linear) values are averaged in linear light, then
 * encoded to sRGB. Runs in the pixel worker.
 */
import type { Rect } from '../document/geometry';
import { maxSampleValue, type PixelFormat, type SampleArray } from '../document/pixel-format';
import { TILE_SIZE, tileIndex, tileKey } from '../document/tile';
import { linearToSrgb } from '../color/srgb';

export interface ThumbnailSource {
  format: PixelFormat;
  /** Value of pixels in unallocated tiles. */
  defaultPixel: readonly number[];
  tiles: { tx: number; ty: number; data: SampleArray }[];
  offsetX: number;
  offsetY: number;
}

export interface Thumbnail {
  width: number;
  height: number;
  /** RGBA, 8-bit sRGB, straight alpha (ImageData layout). */
  data: Uint8ClampedArray;
}

/** Thumbnail dimensions for an area fitted inside a `box` × `box` square. */
export function thumbnailSize(areaWidth: number, areaHeight: number, box: number): { width: number; height: number } {
  const scale = box / Math.max(areaWidth, areaHeight);
  return {
    width: Math.max(1, Math.round(areaWidth * scale)),
    height: Math.max(1, Math.round(areaHeight * scale)),
  };
}

export function renderThumbnail(source: ThumbnailSource, area: Rect, width: number, height: number): Thumbnail {
  const { format } = source;
  const cc = format.colorChannels;
  if (cc !== 1 && cc !== 3) throw new Error('Thumbnails of this colour mode are not supported yet');
  const spp = cc + (format.hasAlpha ? 1 : 0);
  const scale = 1 / maxSampleValue(format.depth);
  const linear = format.depth === 32;
  const tiles = new Map<number, SampleArray>();
  for (const t of source.tiles) tiles.set(tileKey(t.tx, t.ty), t.data);

  const footX = area.w / width;
  const footY = area.h / height;
  const nx = Math.min(4, Math.max(1, Math.ceil(footX)));
  const ny = Math.min(4, Math.max(1, Math.ceil(footY)));
  const out = new Uint8ClampedArray(width * height * 4);
  const dp = source.defaultPixel;
  const sample = [0, 0, 0, 0];

  const read = (docX: number, docY: number) => {
    const lx = docX - source.offsetX;
    const ly = docY - source.offsetY;
    const tx = tileIndex(lx);
    const ty = tileIndex(ly);
    const tile = tiles.get(tileKey(tx, ty));
    let a: number;
    if (tile) {
      const o = ((ly - ty * TILE_SIZE) * TILE_SIZE + (lx - tx * TILE_SIZE)) * spp;
      a = format.hasAlpha ? tile[o + cc]! * scale : 1;
      for (let c = 0; c < 3; c++) sample[c] = tile[o + (cc === 1 ? 0 : c)]! * scale;
    } else {
      a = format.hasAlpha ? dp[cc]! * scale : 1;
      for (let c = 0; c < 3; c++) sample[c] = dp[cc === 1 ? 0 : c]! * scale;
    }
    sample[3] = a;
  };

  for (let oy = 0; oy < height; oy++) {
    for (let ox = 0; ox < width; ox++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < ny; j++) {
        const docY = Math.floor(area.y + (oy + (j + 0.5) / ny) * footY);
        for (let i = 0; i < nx; i++) {
          const docX = Math.floor(area.x + (ox + (i + 0.5) / nx) * footX);
          read(docX, docY);
          const sa = sample[3]!;
          r += sample[0]! * sa;
          g += sample[1]! * sa;
          b += sample[2]! * sa;
          a += sa;
        }
      }
      const o = (oy * width + ox) * 4;
      if (a > 0) {
        const enc = (v: number) => (linear ? linearToSrgb(Math.min(1, v / a)) : v / a) * 255;
        out[o] = enc(r);
        out[o + 1] = enc(g);
        out[o + 2] = enc(b);
      }
      out[o + 3] = (a / (nx * ny)) * 255;
    }
  }
  return { width, height, data: out };
}
