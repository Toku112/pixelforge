/**
 * Colour sampling (the Eyedropper, and Alt-click with the painting tools).
 *
 * Behaviour (own summary of the reference app):
 * - Sample Size: the pixel under the pointer, or the average of a square around it
 *   (3 × 3 … 101 × 101).
 * - Sample: the current layer only, the current layer and those below it, or all
 *   layers (what you see).
 * - Transparent pixels add nothing to the average; where nothing is painted at all,
 *   the colour stays as it was.
 */
import type { RGB } from '../color/color';
import { linearToSrgb } from '../color/srgb';
import {
  flatten,
  planFromDocument,
  planNode,
  type Composite,
  type FlattenNode,
  type FlattenPlan,
} from '../composite/flatten';
import type { ImageDocument } from '../document/document';
import type { Rect } from '../document/geometry';
import type { LayerNode } from '../document/layers';
import type { BitDepth, ColorMode } from '../document/pixel-format';

export type SampleSource = 'current' | 'current-below' | 'all';
export const SAMPLE_SIZES = [1, 3, 5, 11, 31, 51, 101] as const;
export type SampleSize = (typeof SAMPLE_SIZES)[number];

export interface EyedropperOptions {
  sampleSize: SampleSize;
  source: SampleSource;
  /** The ring showing the new colour over the current one while sampling. */
  showRing: boolean;
}

export const DEFAULT_EYEDROPPER: Readonly<EyedropperOptions> = Object.freeze({
  sampleSize: 1,
  source: 'all',
  showRing: true,
});

/** The square sampled around document point (x, y), clipped to the canvas; null outside it. */
export function sampleRect(x: number, y: number, size: number, canvas: Rect): Rect | null {
  const half = Math.floor(size / 2);
  const x0 = Math.max(canvas.x, Math.floor(x) - half);
  const y0 = Math.max(canvas.y, Math.floor(y) - half);
  const x1 = Math.min(canvas.x + canvas.w, Math.floor(x) - half + size);
  const y1 = Math.min(canvas.y + canvas.h, Math.floor(y) - half + size);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * The layers sampled: `nodes` (bottom first) up to and including `target`, descending into the
 * group that holds it; null when `target` is not among them.
 */
function upTo(nodes: readonly LayerNode[], target: LayerNode): FlattenNode[] | null {
  const out: FlattenNode[] = [];
  for (const node of nodes) {
    if (node === target) return [...out, planNode(node)];
    if (node.kind === 'group') {
      const inner = upTo(node.children, target);
      if (inner) return [...out, { ...(planNode(node) as Extract<FlattenNode, { kind: 'group' }>), children: inner }];
    }
    out.push(planNode(node));
  }
  return null;
}

/** What is sampled, as a flatten plan. */
export function samplePlan(doc: ImageDocument, source: SampleSource): FlattenPlan {
  const active = doc.activeLayer;
  if (source === 'all' || !active) return planFromDocument(doc);
  if (source === 'current') return { ...planFromDocument(doc, []), layers: [planNode(active)] };
  return { ...planFromDocument(doc, []), layers: upTo(doc.root.children, active) ?? [] };
}

/** The average colour of a composite (0–1 per colour channel, unpremultiplied), or null where nothing is painted. */
export function averageColor(composite: Composite): number[] | null {
  const cc = composite.colorChannels;
  const stride = cc + 1;
  const sums = new Float64Array(cc);
  let alpha = 0;
  for (let i = 0; i < composite.data.length; i += stride) {
    for (let c = 0; c < cc; c++) sums[c]! += composite.data[i + c]!;
    alpha += composite.data[i + cc]!;
  }
  if (alpha <= 0) return null;
  return Array.from(sums, (s) => s / alpha);
}

/** Samples a document's area (see sampleRect / samplePlan); null where nothing is painted. */
export function sampleArea(plan: FlattenPlan, rect: Rect): number[] | null {
  return averageColor(flatten(plan, rect));
}

/** A sampled colour (document channels, 0–1; linear light in 32-bit) as sRGB. */
export function sampledToRgb(values: readonly number[], mode: ColorMode, depth: BitDepth): RGB {
  const decode = (v: number) => Math.min(1, Math.max(0, depth === 32 ? linearToSrgb(Math.min(1, Math.max(0, v))) : v));
  if (mode === 'grayscale') {
    const g = decode(values[0] ?? 0);
    return { r: g, g, b: g };
  }
  return { r: decode(values[0] ?? 0), g: decode(values[1] ?? 0), b: decode(values[2] ?? 0) };
}
