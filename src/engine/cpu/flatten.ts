/**
 * CPU compositor: flattens a document's visible layers into one image.
 *
 * Used for export (in a worker) and as the reference the GPU compositor is tested
 * against. Works in the document's own encoding (gamma-encoded values for 8/16-bit,
 * linear light for 32-bit), as the reference app does by default.
 *
 * Normal blend, with straight-alpha layers (docs/FORMAT_NOTES.md §3):
 *   a  = layer alpha × opacity × fill
 *   C' = C_layer·a + C_backdrop·(1 − a)        (premultiplied colour)
 *   A' = a + A_backdrop·(1 − a)
 * Groups other than Pass Through are isolated: children are composited onto a
 * transparent buffer, which is then composited with the group's opacity. Pass
 * Through groups composite their children directly onto the backdrop; the group's
 * opacity then mixes between the backdrop before and after the group.
 */
import type { Rect } from '../../core/document/geometry';
import type { BlendMode } from '../../core/document/layers';
import type { ImageDocument } from '../../core/document/document';
import type { LayerNode } from '../../core/document/layers';
import { maxSampleValue, type BitDepth, type SampleArray } from '../../core/document/pixel-format';
import { TILE_SIZE, tileIndex, tileKey } from '../../core/document/tile';

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
  blendMode: BlendMode;
  children: FlattenNode[];
}

export type FlattenNode = FlattenPixelLayer | FlattenGroupLayer;

/** Everything needed to flatten a document; plain data, so it can be posted to a worker. */
export interface FlattenPlan {
  width: number;
  height: number;
  depth: BitDepth;
  colorChannels: number;
  layers: FlattenNode[];
}

/** Builds a flatten plan referencing the document's tiles (no pixel copies). */
export function planFromDocument(doc: ImageDocument): FlattenPlan {
  const toNode = (layer: LayerNode): FlattenNode => {
    if (layer.kind === 'group') {
      return {
        kind: 'group',
        visible: layer.visible,
        opacity: layer.opacity,
        blendMode: layer.blendMode,
        children: layer.children.map(toNode),
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
  };
  return {
    width: doc.width,
    height: doc.height,
    depth: doc.depth,
    colorChannels: doc.colorChannels,
    layers: doc.root.children.map(toNode),
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

export function flatten(plan: FlattenPlan, rect: Rect = { x: 0, y: 0, w: plan.width, h: plan.height }): Composite {
  const stride = plan.colorChannels + 1;
  const data = new Float32Array(rect.w * rect.h * stride);
  compositeNodes(plan, plan.layers, rect, data);
  return { rect, colorChannels: plan.colorChannels, data };
}

function compositeNodes(plan: FlattenPlan, nodes: FlattenNode[], rect: Rect, acc: Float32Array): void {
  for (const node of nodes) {
    if (!node.visible || node.opacity === 0) continue;
    if (node.kind === 'pixel') {
      checkBlendMode(node.blendMode);
      compositePixelLayer(plan, node, rect, acc);
    } else if (node.blendMode === 'pass-through') {
      const before = node.opacity < 1 ? acc.slice() : null;
      compositeNodes(plan, node.children, rect, acc);
      if (before) for (let i = 0; i < acc.length; i++) acc[i] = before[i]! + (acc[i]! - before[i]!) * node.opacity;
    } else {
      checkBlendMode(node.blendMode);
      const group = new Float32Array(acc.length);
      compositeNodes(plan, node.children, rect, group);
      overPremultiplied(acc, group, node.opacity, plan.colorChannels + 1);
    }
  }
}

function checkBlendMode(mode: BlendMode): void {
  if (mode !== 'normal') throw new UnsupportedBlendModeError(`The ${mode} blend mode is not supported yet`);
}

/** acc = src·k over acc, both premultiplied. */
function overPremultiplied(acc: Float32Array, src: Float32Array, k: number, stride: number): void {
  for (let i = 0; i < acc.length; i += stride) {
    const a = src[i + stride - 1]! * k;
    if (a === 0) continue;
    const inv = 1 - a;
    for (let c = 0; c < stride - 1; c++) acc[i + c] = src[i + c]! * k + acc[i + c]! * inv;
    acc[i + stride - 1] = a + acc[i + stride - 1]! * inv;
  }
}

function compositePixelLayer(plan: FlattenPlan, layer: FlattenPixelLayer, rect: Rect, acc: Float32Array): void {
  const cc = plan.colorChannels;
  const stride = cc + 1;
  const spp = cc + (layer.hasAlpha ? 1 : 0);
  const max = maxSampleValue(plan.depth);
  const scale = 1 / max;
  const k = layer.opacity * layer.fillOpacity;
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
        let alpha: number;
        if (tile) {
          const s = (rowInTile * TILE_SIZE + (x - layer.offsetX - tx * TILE_SIZE)) * spp;
          alpha = (layer.hasAlpha ? tile[s + cc]! * scale : 1) * k;
          if (alpha === 0) continue;
          const inv = 1 - alpha;
          for (let c = 0; c < cc; c++) acc[o + c] = tile[s + c]! * scale * alpha + acc[o + c]! * inv;
          acc[o + cc] = alpha + acc[o + cc]! * inv;
        } else {
          alpha = defaultAlpha * k;
          const inv = 1 - alpha;
          for (let c = 0; c < cc; c++) acc[o + c] = layer.defaultPixel[c]! * scale * alpha + acc[o + c]! * inv;
          acc[o + cc] = alpha + acc[o + cc]! * inv;
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
