/**
 * The Gradient tool's fill into layer tiles (runs in the pixel worker): every pixel
 * of the selection (or the canvas) takes the gradient's colour at its position,
 * blended like Edit > Fill (see fill.ts).
 */
import { maxSampleValue, type PixelFormat, type SampleArray } from '../document/pixel-format';
import type { MaskedTarget } from '../selection/masked-edits';
import { blendSourceTiles, type BlendSpec } from './fill';
import { ditherNoise, positionFunction, type GradientGeometry } from './gradient';

export interface GradientFillSpec extends BlendSpec {
  /** The gradient as the document's channel values and alpha per entry (see gradientSamples). */
  table: Float32Array;
  geometry: GradientGeometry;
  /** Breaks up banding with a little noise (8- and 16-bit). */
  dither: boolean;
}

export function gradientTiles(
  tiles: SampleArray[],
  format: PixelFormat,
  target: MaskedTarget,
  spec: GradientFillSpec,
  hdr: boolean,
): void {
  const cc = format.colorChannels;
  const n = cc + 1;
  const table = spec.table;
  const steps = table.length / n;
  if (!Number.isInteger(steps) || steps < 2) throw new Error('gradient: the table does not fit the document');
  const position = positionFunction(spec.geometry);
  const dither = spec.dither && format.depth !== 32 ? 1 / maxSampleValue(format.depth) : 0;
  blendSourceTiles(tiles, format, target, spec, hdr, (x, y, out) => {
    // At the pixel's centre, between two table entries.
    const f = position(x + 0.5, y + 0.5) * (steps - 1);
    const i = Math.min(steps - 2, Math.floor(f));
    const w = f - i;
    const o = i * n;
    const noise = dither === 0 ? 0 : ditherNoise(x, y) * dither;
    for (let c = 0; c < cc; c++) out[c] = table[o + c]! + (table[o + n + c]! - table[o + c]!) * w + noise;
    return table[o + cc]! + (table[o + n + cc]! - table[o + cc]!) * w;
  });
}
