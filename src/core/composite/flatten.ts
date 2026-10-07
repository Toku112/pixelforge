/**
 * CPU compositor: flattens a document's visible layers into one image.
 *
 * Used for export and merges (in workers) and as the reference the GPU compositor
 * is tested against. Works in the document's own encoding (gamma-encoded values for
 * 8/16-bit, linear light for 32-bit), as the reference app does by default.
 *
 * Compositing (docs/FORMAT_NOTES.md §3), with backdrop premultiplied colour Pb and
 * alpha ab, layer colour Cs, and the layer's coverage split into the part over the
 * backdrop (asB) and over transparency (asT):
 *   Po = asT·(1 − ab)·Cs + asB·ab·B(Cb, Cs) + (1 − asB)·Pb
 *   Ao = ab + (1 − ab)·asT
 * For most modes asB = asT = alpha × opacity × fill; for the "special eight" Fill is
 * applied inside B instead, so asB = alpha × opacity and asT = asB × fill. With
 * Normal this is the usual "over" operator.
 *
 * Groups other than Pass Through are isolated: children are composited onto a
 * transparent buffer, which is then blended with the group's mode, opacity and fill.
 * Pass Through groups composite their children directly onto the backdrop; the
 * group's opacity then mixes between the backdrop before and after the group.
 * CMYK documents blend on inverted (additive) values, as the reference app does.
 */
import type { ImageDocument } from '../document/document';
import type { Rect } from '../document/geometry';
import type { BlendMode, LayerBlendMode, LayerNode } from '../document/layers';
import { maxSampleValue, type BitDepth, type ColorMode, type SampleArray } from '../document/pixel-format';
import { TILE_SIZE, tileIndex, tileKey } from '../document/tile';
import { SPECIAL_EIGHT, blendChannel, blendColor, dissolveNoise, isWholeColorMode } from './blend';

export interface FlattenTile {
  tx: number;
  ty: number;
  data: SampleArray;
}

export interface FlattenPixelLayer {
  kind: 'pixel';
  visible: boolean;
  opacity: number;
  fillOpacity: number;
  blendMode: BlendMode;
  offsetX: number;
  offsetY: number;
  hasAlpha: boolean;
  defaultPixel: readonly number[];
  tiles: FlattenTile[];
}

export interface FlattenGroupLayer {
  kind: 'group';
  visible: boolean;
  opacity: number;
  fillOpacity: number;
  blendMode: BlendMode;
  children: FlattenNode[];
}

export type FlattenNode = FlattenPixelLayer | FlattenGroupLayer;

/** Everything needed to flatten a document; plain data, so it can be posted to a worker. */
export interface FlattenPlan {
  width: number;
  height: number;
  depth: BitDepth;
  mode: ColorMode;
  colorChannels: number;
  layers: FlattenNode[];
}

/** Plan for one layer node (pixel layer or group). */
export function planNode(layer: LayerNode): FlattenNode {
  if (layer.kind === 'group') {
    return {
      kind: 'group',
      visible: layer.visible,
      opacity: layer.opacity,
      fillOpacity: layer.fillOpacity,
      blendMode: layer.blendMode,
      children: layer.children.map(planNode),
    };
  }
  const tiles: FlattenTile[] = [];
  for (const [tx, ty, tile] of layer.buffer.tiles()) tiles.push({ tx, ty, data: tile.data });
  return {
    kind: 'pixel',
    visible: layer.visible,
    opacity: layer.opacity,
    fillOpacity: layer.fillOpacity,
    blendMode: layer.blendMode,
    offsetX: layer.offsetX,
    offsetY: layer.offsetY,
    hasAlpha: layer.buffer.format.hasAlpha,
    defaultPixel: layer.buffer.defaultPixel,
    tiles,
  };
}

/** Builds a flatten plan referencing the document's tiles (no pixel copies). */
export function planFromDocument(doc: ImageDocument, layers: readonly LayerNode[] = doc.root.children): FlattenPlan {
  return {
    width: doc.width,
    height: doc.height,
    depth: doc.depth,
    mode: doc.mode,
    colorChannels: doc.colorChannels,
    layers: layers.map(planNode),
  };
}

/** Premultiplied composite: per pixel, colorChannels colour values then alpha, all 0–1 (colour may exceed 1 in 32-bit). */
export interface Composite {
  rect: Rect;
  colorChannels: number;
  data: Float32Array;
}

export class UnsupportedBlendModeError extends Error {
  override readonly name = 'UnsupportedBlendModeError';
}

interface BlendParams {
  mode: LayerBlendMode;
  opacity: number;
  fill: number;
  special: boolean;
  whole: boolean;
  hdr: boolean;
  inverted: boolean;
  cc: number;
}

function blendParams(plan: FlattenPlan, mode: BlendMode, opacity: number, fill: number): BlendParams {
  if (mode === 'pass-through') throw new UnsupportedBlendModeError('Pass Through applies to groups only');
  return {
    mode,
    opacity,
    fill,
    special: SPECIAL_EIGHT.has(mode),
    whole: isWholeColorMode(mode),
    hdr: plan.depth === 32,
    inverted: plan.mode === 'cmyk',
    cc: plan.colorChannels,
  };
}

const scratchB = new Float64Array(64);
const scratchCb = new Float64Array(64);

/**
 * Blends one source pixel (straight colour `cs` at `cOff`, alpha `ap`) onto the
 * premultiplied accumulator at `o`. `x, y` are document coordinates (for Dissolve).
 */
function blendInto(
  acc: Float32Array,
  o: number,
  cs: ArrayLike<number>,
  cOff: number,
  csScale: number,
  ap: number,
  p: BlendParams,
  x: number,
  y: number,
): void {
  if (ap <= 0) return;
  const cc = p.cc;
  const ab = acc[o + cc]!;
  if (p.mode === 'normal' || p.mode === 'dissolve') {
    let a = ap * p.opacity * p.fill;
    if (p.mode === 'dissolve') {
      if (dissolveNoise(x, y) >= a) return;
      a = 1;
    }
    const inv = 1 - a;
    for (let c = 0; c < cc; c++) acc[o + c] = cs[cOff + c]! * csScale * a + acc[o + c]! * inv;
    acc[o + cc] = a + ab * inv;
    return;
  }
  const asB = ap * p.opacity * (p.special ? 1 : p.fill);
  const asT = p.special ? asB * p.fill : asB;
  // Straight backdrop colour (and blend inputs, inverted for CMYK).
  for (let c = 0; c < cc; c++) scratchCb[c] = ab > 0 ? acc[o + c]! / ab : 0;
  if (ab > 0) {
    const inv = (v: number) => (p.inverted ? 1 - v : v);
    if (p.whole && cc === 3) {
      const b3 = [inv(scratchCb[0]!), inv(scratchCb[1]!), inv(scratchCb[2]!)];
      const s3 = [inv(cs[cOff]! * csScale), inv(cs[cOff + 1]! * csScale), inv(cs[cOff + 2]! * csScale)];
      const r = blendColor(p.mode, b3, s3, p.hdr);
      for (let c = 0; c < 3; c++) scratchB[c] = inv(r[c]!);
    } else if (p.whole) {
      // Single-channel documents: Darker/Lighter Color pick the darker/lighter value; colour modes have no effect.
      for (let c = 0; c < cc; c++) {
        const b = scratchCb[c]!;
        const s = cs[cOff + c]! * csScale;
        // (Luminosity takes the source lightness, i.e. the source value; Hue/Saturation/Color keep the backdrop.)
        scratchB[c] =
          p.mode === 'darker-color'
            ? Math.min(b, s)
            : p.mode === 'lighter-color'
              ? Math.max(b, s)
              : p.mode === 'luminosity'
                ? s
                : b;
      }
    } else {
      for (let c = 0; c < cc; c++) {
        scratchB[c] = inv(
          blendChannel(p.mode, inv(scratchCb[c]!), inv(cs[cOff + c]! * csScale), p.special ? p.fill : 1, p.hdr),
        );
      }
    }
  }
  for (let c = 0; c < cc; c++) {
    const s = cs[cOff + c]! * csScale;
    acc[o + c] = asT * (1 - ab) * s + (ab > 0 ? asB * ab * scratchB[c]! : 0) + (1 - asB) * acc[o + c]!;
  }
  acc[o + cc] = ab + (1 - ab) * asT;
}

export function flatten(plan: FlattenPlan, rect: Rect = { x: 0, y: 0, w: plan.width, h: plan.height }): Composite {
  const stride = plan.colorChannels + 1;
  const data = new Float32Array(rect.w * rect.h * stride);
  compositeNodes(plan, plan.layers, rect, data);
  return { rect, colorChannels: plan.colorChannels, data };
}

function compositeNodes(plan: FlattenPlan, nodes: FlattenNode[], rect: Rect, acc: Float32Array): void {
  const stride = plan.colorChannels + 1;
  for (const node of nodes) {
    if (!node.visible || node.opacity === 0) continue;
    if (node.kind === 'pixel') {
      compositePixelLayer(plan, node, rect, acc);
    } else if (node.blendMode === 'pass-through') {
      const before = node.opacity < 1 ? acc.slice() : null;
      compositeNodes(plan, node.children, rect, acc);
      if (before) for (let i = 0; i < acc.length; i++) acc[i] = before[i]! + (acc[i]! - before[i]!) * node.opacity;
    } else {
      const group = new Float32Array(acc.length);
      compositeNodes(plan, node.children, rect, group);
      const p = blendParams(plan, node.blendMode, node.opacity, node.fillOpacity);
      for (let i = 0, px = 0; i < acc.length; i += stride, px++) {
        const a = group[i + stride - 1]!;
        if (a <= 0) continue;
        blendInto(acc, i, group, i, 1 / a, a, p, rect.x + (px % rect.w), rect.y + Math.floor(px / rect.w));
      }
    }
  }
}

function compositePixelLayer(plan: FlattenPlan, layer: FlattenPixelLayer, rect: Rect, acc: Float32Array): void {
  const cc = plan.colorChannels;
  const stride = cc + 1;
  const spp = cc + (layer.hasAlpha ? 1 : 0);
  const scale = 1 / maxSampleValue(plan.depth);
  const p = blendParams(plan, layer.blendMode, layer.opacity, layer.fillOpacity);
  const tiles = new Map<number, SampleArray>();
  for (const t of layer.tiles) tiles.set(tileKey(t.tx, t.ty), t.data);

  const defaultAlpha = layer.hasAlpha ? layer.defaultPixel[cc]! * scale : 1;
  const defaultVisible = defaultAlpha > 0;

  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const ly = y - layer.offsetY;
    const ty = tileIndex(ly);
    const rowInTile = ly - ty * TILE_SIZE;
    let x = rect.x;
    while (x < rect.x + rect.w) {
      const lx = x - layer.offsetX;
      const tx = tileIndex(lx);
      const segmentEnd = Math.min(rect.x + rect.w, tx * TILE_SIZE + TILE_SIZE + layer.offsetX);
      const tile = tiles.get(tileKey(tx, ty));
      if (!tile && !defaultVisible) {
        x = segmentEnd;
        continue;
      }
      for (; x < segmentEnd; x++) {
        const o = ((y - rect.y) * rect.w + (x - rect.x)) * stride;
        if (tile) {
          const s = (rowInTile * TILE_SIZE + (x - layer.offsetX - tx * TILE_SIZE)) * spp;
          blendInto(acc, o, tile, s, scale, layer.hasAlpha ? tile[s + cc]! * scale : 1, p, x, y);
        } else {
          blendInto(acc, o, layer.defaultPixel, 0, scale, defaultAlpha, p, x, y);
        }
      }
    }
  }
}

/** True when every pixel of the composite is fully opaque. */
export function isOpaque(composite: Composite): boolean {
  const stride = composite.colorChannels + 1;
  for (let i = stride - 1; i < composite.data.length; i += stride) if (composite.data[i]! < 1) return false;
  return true;
}

/**
 * Converts a composite to straight-alpha integer samples (8- or 16-bit), rounding
 * to nearest. With `alpha: false` the alpha channel is dropped.
 */
export function compositeToSamples(composite: Composite, depth: 8 | 16, alpha: boolean): Uint8Array | Uint16Array {
  const cc = composite.colorChannels;
  const stride = cc + 1;
  const outStride = cc + (alpha ? 1 : 0);
  const pixels = composite.data.length / stride;
  const max = depth === 8 ? 255 : 65535;
  const out = depth === 8 ? new Uint8Array(pixels * outStride) : new Uint16Array(pixels * outStride);
  for (let p = 0; p < pixels; p++) {
    const i = p * stride;
    const a = composite.data[i + cc]!;
    const o = p * outStride;
    for (let c = 0; c < cc; c++) {
      const v = a > 0 ? composite.data[i + c]! / a : 0;
      out[o + c] = Math.round(Math.min(1, Math.max(0, v)) * max);
    }
    if (alpha) out[o + cc] = Math.round(Math.min(1, Math.max(0, a)) * max);
  }
  return out;
}
