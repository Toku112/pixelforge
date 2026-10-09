/**
 * Edit > Fill into layer tiles (runs in the pixel worker): a solid colour or a
 * pattern blended into each pixel with a blend mode and opacity, through the
 * selection (or the whole canvas), using the compositing formula of FORMAT_NOTES §3.2.
 * Patterns repeat from the document's top left corner.
 *
 * Preserve Transparency (and layers without alpha) keep each pixel's alpha and
 * only move its colour towards the blended colour.
 *
 * History contents bring back the History Brush source's version of the layer, as
 * the History Brush does: in Normal (and Dissolve) mode each pixel moves towards the
 * source pixel, transparency included.
 */
import { maxSampleValue, samplesPerPixel, type PixelFormat, type SampleArray } from '../document/pixel-format';
import type { LayerBlendMode } from '../document/layers';
import { blendChannel, blendColor, dissolveNoise, isWholeColorMode } from '../composite/blend';
import { TILE_SIZE, tileIndex, tileKey } from '../document/tile';

/** log2(TILE_SIZE): pixel index → row. */
const TILE_SHIFT = Math.log2(TILE_SIZE);
import { MaskReader } from '../selection/mask-ops';
import type { MaskedTarget } from '../selection/masked-edits';
import type { PatternPixels } from '../pattern/pattern';
import type { SourcePixels } from '../history/history-source';

export interface FillSpec extends BlendSpec {
  /** Colour samples of the fill. */
  color: number[];
  /** A pattern instead of the colour. */
  pattern?: PatternPixels | null;
  /** History contents: the layer as it was in the History Brush source state. */
  history?: SourcePixels | null;
}

export function fillTiles(
  tiles: SampleArray[],
  format: PixelFormat,
  target: MaskedTarget,
  spec: FillSpec,
  hdr: boolean,
): void {
  if (spec.history) {
    blendSourceTiles(tiles, format, target, spec, hdr, historySource(spec.history), true);
    return;
  }
  const pattern = spec.pattern;
  if (pattern) {
    blendSourceTiles(tiles, format, target, spec, hdr, patternSource(pattern, format.colorChannels, 0, 0));
    return;
  }
  const max = maxSampleValue(format.depth);
  const s = spec.color.map((v) => v / max);
  blendSourceTiles(tiles, format, target, spec, hdr, (_x, _y, out) => {
    for (let c = 0; c < s.length; c++) out[c] = s[c]!;
    return 1;
  });
}

/** A pattern repeated from document point (originX, originY), as a blend source. */
export function patternSource(
  pattern: PatternPixels,
  cc: number,
  originX: number,
  originY: number,
): (x: number, y: number, out: number[]) => number {
  const { width: w, height: h, data } = pattern;
  if (data.length !== w * h * (cc + 1)) throw new Error('fill: the pattern does not fit the document');
  return (x, y, out) => {
    const px = (((x - originX) % w) + w) % w;
    const py = (((y - originY) % h) + h) % h;
    const o = (py * w + px) * (cc + 1);
    for (let c = 0; c < cc; c++) out[c] = data[o + c]!;
    return data[o + cc]!;
  };
}

/** A history state's version of the layer, as a blend source. */
export function historySource(history: SourcePixels): (x: number, y: number, out: number[]) => number {
  const { format, defaultPixel, offsetX, offsetY } = history;
  const cc = format.colorChannels;
  const spp = samplesPerPixel(format);
  const max = maxSampleValue(format.depth);
  const tiles = new Map<number, SampleArray>(history.tiles.map((t) => [tileKey(t.tx, t.ty), t.data]));
  return (x, y, out) => {
    const sx = x - offsetX;
    const sy = y - offsetY;
    const tx = tileIndex(sx);
    const ty = tileIndex(sy);
    const data = tiles.get(tileKey(tx, ty));
    const o = data ? ((sy - ty * TILE_SIZE) * TILE_SIZE + (sx - tx * TILE_SIZE)) * spp : 0;
    const px = data ?? defaultPixel;
    for (let c = 0; c < cc; c++) out[c] = px[o + c]! / max;
    return format.hasAlpha ? px[o + cc]! / max : 1;
  };
}

/** How a source is blended into a layer (Fill, Gradient). */
export interface BlendSpec {
  /** Behind paints only where the layer is transparent; Clear takes pixels away (layers with editable alpha only). */
  mode: LayerBlendMode | 'behind' | 'clear';
  /** 0–1. */
  opacity: number;
  preserveTransparency: boolean;
}

/**
 * Blends a source into layer tiles through the selection: `source(x, y, out)` writes the
 * source's colour (channel values 0–1; 32-bit: linear) at document pixel (x, y) into `out`
 * and returns its opacity (0–1). With `restore`, Normal and Dissolve move pixels towards
 * the source's, transparency included (History contents).
 */
export function blendSourceTiles(
  tiles: SampleArray[],
  format: PixelFormat,
  target: MaskedTarget,
  spec: BlendSpec,
  hdr: boolean,
  source: (x: number, y: number, out: number[]) => number,
  restore = false,
): void {
  const cc = format.colorChannels;
  const spp = samplesPerPixel(format);
  const max = maxSampleValue(format.depth);
  const keepAlpha = !format.hasAlpha || spec.preserveTransparency;
  const mode = spec.mode;
  // Behind and Clear change only transparency: nothing to do where it is kept.
  if ((mode === 'behind' || mode === 'clear') && keepAlpha) return;
  const whole = mode !== 'behind' && mode !== 'clear' && isWholeColorMode(mode);
  const q = format.depth === 32 ? (v: number) => v : (v: number) => Math.round(Math.min(1, Math.max(0, v)) * max);
  const reader = new MaskReader(target.mask);
  const s = new Array<number>(cc).fill(0);
  const b = new Array<number>(cc).fill(0);
  const blended = new Array<number>(cc).fill(0);

  tiles.forEach((data, index) => {
    const [tx, ty] = target.coords[index]!;
    const mask = reader.layerTile(target.canvas, target.offsetX, target.offsetY, tx, ty);
    if (mask === 0) return;
    const x0 = tx * TILE_SIZE + target.offsetX;
    const y0 = ty * TILE_SIZE + target.offsetY;
    for (let p = 0; p < TILE_SIZE * TILE_SIZE; p++) {
      const m = mask === 255 ? 1 : mask[p]! / 255;
      if (m <= 0) continue;
      const x = x0 + (p & (TILE_SIZE - 1));
      const y = y0 + (p >> TILE_SHIFT);
      const i = p * spp;
      const ab = format.hasAlpha ? data[i + cc]! / max : 1;
      if (keepAlpha && ab === 0) continue; // nothing there to recolour
      const as = source(x, y, s);
      if (restore && (mode === 'normal' || mode === 'dissolve')) {
        let t = spec.opacity * m;
        if (mode === 'dissolve') t = dissolveNoise(x, y) < t ? 1 : 0;
        if (t <= 0) continue;
        if (keepAlpha) {
          for (let c = 0; c < cc; c++) data[i + c] = q(data[i + c]! / max + (s[c]! - data[i + c]! / max) * t * as);
          continue;
        }
        const ao = ab + (as - ab) * t;
        for (let c = 0; c < cc; c++) {
          const v = data[i + c]! / max;
          data[i + c] = q(ao > 0 ? (ab * (1 - t) * v + as * t * s[c]!) / ao : v);
        }
        data[i + cc] = q(ao);
        continue;
      }
      let a = spec.opacity * m * as;
      if (mode === 'dissolve') a = dissolveNoise(x, y) < a ? 1 : 0;
      if (a <= 0) continue;
      if (mode === 'normal') {
        // The common case, without the general blend: the source over the pixel.
        if (keepAlpha) {
          for (let c = 0; c < cc; c++) data[i + c] = q(data[i + c]! / max + (s[c]! - data[i + c]! / max) * a);
          continue;
        }
        const ao = ab + (1 - ab) * a;
        const keep = (1 - a) * ab;
        for (let c = 0; c < cc; c++) data[i + c] = q((a * s[c]! + (keep * data[i + c]!) / max) / ao);
        data[i + cc] = q(ao);
        continue;
      }
      if (mode === 'clear') {
        data[i + cc] = q(ab * (1 - a));
        continue;
      }
      for (let c = 0; c < cc; c++) b[c] = data[i + c]! / max;
      if (mode === 'behind') {
        // The source under the pixel.
        const ao = ab + (1 - ab) * a;
        for (let c = 0; c < cc; c++) data[i + c] = q(ao > 0 ? (ab * b[c]! + (1 - ab) * a * s[c]!) / ao : 0);
        data[i + cc] = q(ao);
        continue;
      }
      // The blended colour where the pixel exists.
      if (whole && cc === 3) {
        const r = blendColor(mode, b, s, hdr);
        for (let c = 0; c < 3; c++) blended[c] = r[c]!;
      } else if (whole) {
        for (let c = 0; c < cc; c++) {
          blended[c] =
            mode === 'darker-color'
              ? Math.min(b[c]!, s[c]!)
              : mode === 'lighter-color'
                ? Math.max(b[c]!, s[c]!)
                : mode === 'luminosity'
                  ? s[c]!
                  : b[c]!;
        }
      } else {
        for (let c = 0; c < cc; c++) blended[c] = blendChannel(mode, b[c]!, s[c]!, 1, hdr);
      }
      if (keepAlpha) {
        for (let c = 0; c < cc; c++) data[i + c] = q(b[c]! + (blended[c]! - b[c]!) * a);
        continue;
      }
      // Over transparency the source shows as it is; over the pixel, as blended.
      const ao = ab + (1 - ab) * a;
      for (let c = 0; c < cc; c++) {
        const premul = a * (1 - ab) * s[c]! + a * ab * blended[c]! + (1 - a) * ab * b[c]!;
        data[i + c] = q(ao > 0 ? premul / ao : 0);
      }
      data[i + cc] = q(ao);
    }
  });
}
