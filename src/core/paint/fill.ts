/**
 * Edit > Fill into layer tiles (runs in the pixel worker): a solid colour blended
 * into each pixel with a blend mode and opacity, through the selection (or the
 * whole canvas), using the compositing formula of FORMAT_NOTES §3.2.
 *
 * Preserve Transparency (and layers without alpha) keep each pixel's alpha and
 * only move its colour towards the blended colour.
 */
import { maxSampleValue, samplesPerPixel, type PixelFormat, type SampleArray } from '../document/pixel-format';
import type { LayerBlendMode } from '../document/layers';
import { blendChannel, blendColor, dissolveNoise, isWholeColorMode } from '../composite/blend';
import { TILE_SIZE } from '../document/tile';
import { MaskReader } from '../selection/mask-ops';
import type { MaskedTarget } from '../selection/masked-edits';

export interface FillSpec {
  /** Colour samples of the fill. */
  color: number[];
  mode: LayerBlendMode;
  /** 0–1. */
  opacity: number;
  preserveTransparency: boolean;
}

export function fillTiles(
  tiles: SampleArray[],
  format: PixelFormat,
  target: MaskedTarget,
  spec: FillSpec,
  hdr: boolean,
): void {
  const cc = format.colorChannels;
  const spp = samplesPerPixel(format);
  const max = maxSampleValue(format.depth);
  const keepAlpha = !format.hasAlpha || spec.preserveTransparency;
  const whole = isWholeColorMode(spec.mode);
  const s = spec.color.map((v) => v / max);
  const q = format.depth === 32 ? (v: number) => v : (v: number) => Math.round(Math.min(1, Math.max(0, v)) * max);
  const reader = new MaskReader(target.mask);
  const b = new Array<number>(cc).fill(0);
  const blended = new Array<number>(cc).fill(0);

  tiles.forEach((data, index) => {
    const [tx, ty] = target.coords[index]!;
    const mask = reader.layerTile(target.canvas, target.offsetX, target.offsetY, tx, ty);
    if (mask === 0) return;
    for (let p = 0; p < TILE_SIZE * TILE_SIZE; p++) {
      const m = mask === 255 ? 1 : mask[p]! / 255;
      if (m <= 0) continue;
      let a = spec.opacity * m;
      if (spec.mode === 'dissolve') {
        const x = tx * TILE_SIZE + (p % TILE_SIZE) + target.offsetX;
        const y = ty * TILE_SIZE + Math.floor(p / TILE_SIZE) + target.offsetY;
        a = dissolveNoise(x, y) < a ? 1 : 0;
        if (a === 0) continue;
      }
      const i = p * spp;
      const ab = format.hasAlpha ? data[i + cc]! / max : 1;
      if (keepAlpha && ab === 0) continue; // nothing there to recolour
      for (let c = 0; c < cc; c++) b[c] = data[i + c]! / max;
      // The blended colour where the pixel exists.
      if (whole && cc === 3) {
        const r = blendColor(spec.mode, b, s, hdr);
        for (let c = 0; c < 3; c++) blended[c] = r[c]!;
      } else if (whole) {
        for (let c = 0; c < cc; c++) {
          blended[c] =
            spec.mode === 'darker-color'
              ? Math.min(b[c]!, s[c]!)
              : spec.mode === 'lighter-color'
                ? Math.max(b[c]!, s[c]!)
                : spec.mode === 'luminosity'
                  ? s[c]!
                  : b[c]!;
        }
      } else {
        for (let c = 0; c < cc; c++) blended[c] = blendChannel(spec.mode, b[c]!, s[c]!, 1, hdr);
      }
      if (keepAlpha) {
        for (let c = 0; c < cc; c++) data[i + c] = q(b[c]! + (blended[c]! - b[c]!) * a);
        continue;
      }
      // Over transparency the fill shows as it is; over the pixel, as blended.
      const ao = ab + (1 - ab) * a;
      for (let c = 0; c < cc; c++) {
        const premul = a * (1 - ab) * s[c]! + a * ab * blended[c]! + (1 - a) * ab * b[c]!;
        data[i + c] = q(ao > 0 ? premul / ao : 0);
      }
      data[i + cc] = q(ao);
    }
  });
}
