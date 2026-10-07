/**
 * Moving selected pixels (the Move tool dragged inside a selection; runs in the
 * pixel worker).
 *
 * The pixels under the selection are lifted (as much as the selection covers
 * them), the place they leave becomes transparent — or the background colour on
 * a layer without (editable) transparency — and they are laid down, shifted by
 * (dx, dy), over whatever is there.
 */
import type { Rect } from '../document/geometry';
import { maxSampleValue, samplesPerPixel, type PixelFormat, type SampleArray } from '../document/pixel-format';
import { TILE_SIZE, tileIndex, tileKey } from '../document/tile';
import { MaskReader } from '../selection/mask-ops';
import type { MaskData } from '../selection/selection';

export interface MovePixelsSetup {
  format: PixelFormat;
  /** Value of pixels in tiles not passed as sources. */
  defaultPixel: readonly number[];
  mask: MaskData;
  canvas: Rect;
  /** The layer's position in the document. */
  offsetX: number;
  offsetY: number;
  dx: number;
  dy: number;
  /** Colour samples left behind where alpha cannot change; null for transparency. */
  fill: number[] | null;
  /** Alt-drag: the original stays (the pixels are copied rather than cut). */
  keep: boolean;
}

type TileRef = { tx: number; ty: number; data: SampleArray };

/** Computes `outputs` from the unchanged `sources` (layer tile coordinates). */
export function movePixels(setup: MovePixelsSetup, sources: TileRef[], outputs: TileRef[]): void {
  const { format, dx, dy } = setup;
  const cc = format.colorChannels;
  const spp = samplesPerPixel(format);
  const max = maxSampleValue(format.depth);
  const hasAlpha = format.hasAlpha && !setup.fill;
  const src = new Map<number, SampleArray>();
  for (const s of sources) src.set(tileKey(s.tx, s.ty), s.data);
  const q = format.depth === 32 ? (v: number) => v : (v: number) => Math.round(Math.min(max, Math.max(0, v)));
  const reader = new MaskReader(setup.mask);
  const pixel = new Array<number>(spp).fill(0);

  /** Original samples at layer pixel (lx, ly) into `pixel`. */
  const read = (lx: number, ly: number) => {
    const tx = tileIndex(lx);
    const ty = tileIndex(ly);
    const data = src.get(tileKey(tx, ty));
    if (!data) {
      for (let c = 0; c < spp; c++) pixel[c] = setup.defaultPixel[c]!;
      return;
    }
    const i = ((ly - ty * TILE_SIZE) * TILE_SIZE + (lx - tx * TILE_SIZE)) * spp;
    for (let c = 0; c < spp; c++) pixel[c] = data[i + c]!;
  };

  for (const out of outputs) {
    // Selection where the pixel is (cleared) and where its new content comes from (lifted).
    const here = reader.layerTile(setup.canvas, setup.offsetX, setup.offsetY, out.tx, out.ty);
    const from = reader.layerTile(setup.canvas, setup.offsetX - dx, setup.offsetY - dy, out.tx, out.ty);
    if (here === 0 && from === 0) {
      // Nothing changes in this tile: keep the original.
      const data = src.get(tileKey(out.tx, out.ty));
      if (data) out.data.set(data);
      continue;
    }
    for (let p = 0; p < TILE_SIZE * TILE_SIZE; p++) {
      const lx = out.tx * TILE_SIZE + (p % TILE_SIZE);
      const ly = out.ty * TILE_SIZE + Math.floor(p / TILE_SIZE);
      const m0 = setup.keep || here === 0 ? 0 : here === 255 ? 1 : here[p]! / 255;
      const m1 = from === 0 ? 0 : from === 255 ? 1 : from[p]! / 255;
      const o = p * spp;
      // What stays: the original, emptied (or filled) where it is selected.
      read(lx, ly);
      const keptAlpha = format.hasAlpha ? (pixel[cc]! / max) * (hasAlpha ? 1 - m0 : 1) : 1;
      for (let c = 0; c < cc; c++) {
        const v = pixel[c]!;
        out.data[o + c] = setup.fill ? v + (setup.fill[c]! - v) * m0 : v;
      }
      if (m1 > 0) {
        // What arrives: the lifted pixel, as much as the selection covered it.
        read(lx - dx, ly - dy);
        const af = (format.hasAlpha ? pixel[cc]! / max : 1) * m1;
        if (!hasAlpha) {
          // Alpha stays as it was (no alpha, or locked transparency): only the colour mixes.
          for (let c = 0; c < cc; c++) {
            const kept = out.data[o + c]!;
            out.data[o + c] = q(kept + (pixel[c]! - kept) * af);
          }
          if (format.hasAlpha) out.data[o + cc] = q(keptAlpha * max);
        } else {
          const a = af + keptAlpha * (1 - af);
          for (let c = 0; c < cc; c++) {
            const kept = out.data[o + c]!;
            out.data[o + c] = q(a > 0 ? (pixel[c]! * af + kept * keptAlpha * (1 - af)) / a : kept);
          }
          out.data[o + cc] = q(a * max);
        }
      } else {
        for (let c = 0; c < cc; c++) out.data[o + c] = q(out.data[o + c]!);
        if (format.hasAlpha) out.data[o + cc] = q(keptAlpha * max);
      }
    }
  }
}
