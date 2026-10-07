/**
 * Pixel edits limited by a selection (run in the pixel worker). Each pixel moves
 * from its old value towards the edited one by the selection value: fully where
 * the selection is 255, partly at feathered edges, not at all outside.
 */
import { maxSampleValue, samplesPerPixel, type PixelFormat, type SampleArray } from '../document/pixel-format';
import type { Rect } from '../document/geometry';
import { MaskReader } from './mask-ops';
import type { MaskData } from './selection';

/** The selection and the layer tiles a selection-limited edit applies to. */
export interface MaskedTarget {
  mask: MaskData;
  canvas: Rect;
  /** The layer's offset in the document. */
  offsetX: number;
  offsetY: number;
  /** Layer tile coordinates, one per tile passed alongside. */
  coords: [number, number][];
}

function forEachMasked(
  tiles: SampleArray[],
  target: MaskedTarget,
  edit: (data: SampleArray, pixel: number, amount: number) => void,
  spp: number,
): void {
  const reader = new MaskReader(target.mask);
  tiles.forEach((data, i) => {
    const [tx, ty] = target.coords[i]!;
    const mask = reader.layerTile(target.canvas, target.offsetX, target.offsetY, tx, ty);
    if (mask === 0) return;
    const pixels = data.length / spp;
    for (let p = 0; p < pixels; p++) {
      const m = mask === 255 ? 255 : mask[p]!;
      if (m > 0) edit(data, p * spp, m / 255);
    }
  });
}

/** Inverts colour samples through the selection (alpha unchanged). */
export function invertMasked(tiles: SampleArray[], format: PixelFormat, target: MaskedTarget): void {
  const max = maxSampleValue(format.depth);
  const cc = format.colorChannels;
  forEachMasked(
    tiles,
    target,
    (data, i, t) => {
      for (let c = 0; c < cc; c++) {
        const v = data[i + c]!;
        data[i + c] = Math.round(v + (max - 2 * v) * t);
      }
    },
    samplesPerPixel(format),
  );
}

/**
 * Edit > Clear through the selection: makes pixels transparent, or (with `fill`,
 * colour samples — for the Background or a layer with locked transparency) moves
 * their colour towards the fill colour.
 */
export function clearMasked(
  tiles: SampleArray[],
  format: PixelFormat,
  target: MaskedTarget,
  fill: readonly number[] | null,
): void {
  const cc = format.colorChannels;
  if (!fill && !format.hasAlpha) throw new Error('clearMasked: a layer without transparency needs a fill colour');
  const round = format.depth === 32 ? (v: number) => v : Math.round;
  forEachMasked(
    tiles,
    target,
    (data, i, t) => {
      if (fill) {
        for (let c = 0; c < cc; c++) data[i + c] = round(data[i + c]! + (fill[c]! - data[i + c]!) * t);
      } else {
        data[i + cc] = round(data[i + cc]! * (1 - t));
      }
    },
    samplesPerPixel(format),
  );
}
