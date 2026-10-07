/**
 * Edit > Free Transform: scales, rotates, skews, distorts or puts into perspective
 * the selected layers — or, with a selection, the selected pixels of the active
 * layer (the selection moves with them). One History step, "Free Transform".
 *
 * Behaviour (own summary of the reference app):
 * - Without a selection every selected layer (and the layers inside selected groups)
 *   is transformed. The Background cannot be (convert it to a layer first), nor can
 *   layers whose position or pixels are locked.
 * - With a selection, the selected pixels are lifted from the active layer and laid
 *   down transformed; their old place becomes transparent, or the background colour
 *   on the Background (and where transparency is locked).
 *
 * The transform is a projective matrix in document coordinates (see
 * core/geometry/transform.ts); pixels are resampled in the worker.
 */
import { intersectRects, isEmptyRect, unionRects, type Rect } from '../../document/geometry';
import { effectiveLocks, layerCapabilities, type LayerNode, type PixelLayer } from '../../document/layers';
import type { ImageDocument } from '../../document/document';
import type { SampleArray } from '../../document/pixel-format';
import { adoptTile, tileIndex, tileKey, type Tile } from '../../document/tile';
import { sourceBounds, type ResampleMethod } from '../../geometry/layer-geometry';
import { boundsOf, invert, quadOf, type Mat3 } from '../../geometry/transform';
import type { TransformPixelsSetup } from '../../geometry/transform-pixels';
import { Selection } from '../../selection/selection';
import {
  CommandCancelledError,
  CommandUnavailableError,
  type Command,
  type CommandContext,
  type JsonObject,
} from '../command';
import type { CommandDefinition } from '../registry';
import { LayerTileDiff } from '../tile-diff';
import { layerSource } from './geometry';
import { topLevelTargets } from './layer-common';

export const TRANSFORM_METHODS: readonly ResampleMethod[] = [
  'nearest',
  'bilinear',
  'bicubic',
  'bicubic-smoother',
  'bicubic-sharper',
  'automatic',
];

export type TransformTargets =
  | { kind: 'pixels'; layer: PixelLayer }
  | { kind: 'layers'; layers: PixelLayer[] }
  | { kind: 'refused'; reason: string };

function pixelLayersIn(node: LayerNode): PixelLayer[] {
  return node.kind === 'pixel' ? [node] : node.children.flatMap(pixelLayersIn);
}

/** What Free Transform would change now, or why it cannot run. */
export function transformTargets(doc: ImageDocument): TransformTargets {
  const active = doc.activeLayer;
  if (doc.selection) {
    if (active?.kind !== 'pixel') return { kind: 'refused', reason: 'Select a pixel layer to transform its pixels.' };
    if (!layerCapabilities(active).editPixels) return { kind: 'refused', reason: 'The layer is locked.' };
    return { kind: 'pixels', layer: active };
  }
  const layers = topLevelTargets(doc, undefined).flatMap((id) => pixelLayersIn(doc.requireLayer(id)));
  if (layers.length === 0) return { kind: 'refused', reason: 'No layer is selected.' };
  if (layers.some((l) => l.isBackground))
    return { kind: 'refused', reason: 'The Background layer cannot be transformed. Convert it to a layer first.' };
  if (
    layers.some((l) => {
      const locks = effectiveLocks(l);
      return locks.position || locks.pixels || locks.all;
    })
  )
    return { kind: 'refused', reason: 'A selected layer is locked.' };
  return { kind: 'layers', layers };
}

/** The area a transformed rectangle covers, in whole pixels. */
function coveredArea(forward: Mat3, r: Rect): Rect {
  const b = boundsOf(quadOf(forward, r));
  const x = Math.floor(b.x);
  const y = Math.floor(b.y);
  return { x, y, w: Math.ceil(b.x + b.w) - x, h: Math.ceil(b.y + b.h) - y };
}

/** Layer tiles (layer tile coordinates) covering a document rectangle. */
function tilesOf(r: Rect, layer: PixelLayer): [number, number][] {
  if (isEmptyRect(r)) return [];
  const out: [number, number][] = [];
  const x0 = r.x - layer.offsetX;
  const y0 = r.y - layer.offsetY;
  for (let ty = tileIndex(y0); ty <= tileIndex(y0 + r.h - 1); ty++)
    for (let tx = tileIndex(x0); tx <= tileIndex(x0 + r.w - 1); tx++) out.push([tx, ty]);
  return out;
}

interface LayerChange {
  diff: LayerTileDiff;
  offsetBefore: [number, number];
  offsetAfter: [number, number];
}

class FreeTransformCommand implements Command {
  readonly label = 'Free Transform';
  readonly descriptor: { name: string; params: JsonObject };
  readonly #ctx: CommandContext;
  readonly #forward: Mat3;
  readonly #inverse: Mat3;
  readonly #method: ResampleMethod;
  readonly #color: readonly number[] | undefined;
  /** Live previews only: compute just this area, one sample per `step` pixels. */
  readonly #draft: { area: Rect; step: number } | undefined;
  #changes: LayerChange[] = [];
  #selections: { before: Selection | null; after: Selection | null } | undefined;

  constructor(
    ctx: CommandContext,
    forward: Mat3,
    inverse: Mat3,
    method: ResampleMethod,
    color?: readonly number[],
    draft?: { area: Rect; step: number },
  ) {
    this.#ctx = ctx;
    this.#forward = forward;
    this.#inverse = inverse;
    this.#method = draft ? (draft.step > 1 ? 'nearest' : 'bilinear') : method;
    this.#color = color;
    this.#draft = draft;
    const params: JsonObject = { matrix: [...forward], interpolation: method };
    if (color) params['color'] = [...color];
    if (draft) params['draft'] = { ...draft.area, step: draft.step };
    this.descriptor = { name: 'freeTransform', params };
  }

  get undoBytes(): number {
    return this.#changes.reduce((sum, c) => sum + c.diff.bytes, 0);
  }

  retainedTiles(): Iterable<Tile> {
    return this.#changes.flatMap((c) => [...c.diff.tiles()]);
  }

  #setup(layer: PixelLayer, mask: TransformPixelsSetup['mask'], fill: number[] | null): TransformPixelsSetup {
    const { doc } = this.#ctx;
    return {
      format: layer.buffer.format,
      defaultPixel: layer.buffer.defaultPixel,
      offsetX: layer.offsetX,
      offsetY: layer.offsetY,
      inverse: this.#inverse,
      method: this.#method,
      mask,
      canvas: doc.canvasRect,
      fill,
      draftStep: this.#draft?.step ?? 1,
    };
  }

  async execute(): Promise<void> {
    const { doc, task } = this.#ctx;
    const targets = transformTargets(doc);
    if (targets.kind === 'refused') throw new CommandUnavailableError(targets.reason);
    const changes: LayerChange[] = [];
    try {
      if (targets.kind === 'pixels') await this.#transformPixels(targets.layer, changes);
      else {
        for (const [i, layer] of targets.layers.entries()) {
          if (task?.cancelled) throw new CommandCancelledError();
          await this.#transformLayer(layer, changes);
          task?.progress((i + 1) / targets.layers.length);
        }
      }
    } catch (error) {
      for (const c of changes.reverse()) this.#undoChange(c);
      throw error;
    }
    this.#changes = changes;
  }

  /** A whole layer: new tiles on the document grid, the layer moved to offset 0, 0. */
  async #transformLayer(layer: PixelLayer, changes: LayerChange[]): Promise<void> {
    const { doc, services } = this.#ctx;
    const src = layerSource(doc, layer);
    let area = coveredArea(this.#forward, sourceBounds(src));
    if (this.#draft) area = intersectRects(area, this.#draft.area);
    const tiles = await services.pixelOps.transformLayerPixels(this.#setup(layer, null, null), src.tiles, area);
    const diff = new LayerTileDiff(layer.id);
    const old = [...layer.buffer.tiles()].map(([tx, ty]) => [tx, ty] as const);
    for (const [tx, ty] of old) diff.captureBefore(doc, tx, ty);
    for (const t of tiles) diff.captureBefore(doc, t.tx, t.ty);
    const change: LayerChange = {
      diff,
      offsetBefore: [layer.offsetX, layer.offsetY],
      offsetAfter: [0, 0],
    };
    for (const [tx, ty] of old) layer.buffer.setTile(tx, ty, undefined);
    const format = layer.buffer.format;
    for (const t of tiles) layer.buffer.setTile(t.tx, t.ty, adoptTile(t.data, format, doc.memory));
    doc.updateLayer(layer.id, { offsetX: 0, offsetY: 0 });
    diff.captureAfter(doc);
    changes.push(change);
  }

  /** The selected pixels of a layer, and the selection with them. */
  async #transformPixels(layer: PixelLayer, changes: LayerChange[]): Promise<void> {
    const { doc, services } = this.#ctx;
    const selection = doc.selection!;
    const opaque = !layer.buffer.format.hasAlpha || effectiveLocks(layer).transparency;
    const fill = opaque ? [...(this.#color ?? doc.whitePixel())] : null;
    const from = selection.bounds(doc.canvasRect);
    let to = coveredArea(this.#forward, from);
    // Layers without alpha (the Background) cannot hold pixels outside the canvas.
    if (!layer.buffer.format.hasAlpha) to = intersectRects(to, doc.canvasRect);
    let changed = unionRects(from, to);
    if (this.#draft) changed = intersectRects(changed, this.#draft.area);
    const outputs = tilesOf(changed, layer);
    const sourceKeys = new Map<number, [number, number]>();
    for (const c of [...outputs, ...tilesOf(from, layer)]) sourceKeys.set(tileKey(c[0], c[1]), c);

    const diff = new LayerTileDiff(layer.id);
    for (const [tx, ty] of outputs) diff.captureBefore(doc, tx, ty);
    const sources: { tx: number; ty: number; data: SampleArray }[] = [];
    for (const [tx, ty] of sourceKeys.values()) {
      const tile = layer.buffer.captureTile(tx, ty);
      if (tile) sources.push({ tx, ty, data: tile.data });
    }
    const newMask = await services.pixelOps.transformMask(
      selection.data,
      this.#inverse,
      coveredArea(this.#forward, from),
      doc.canvasRect,
    );
    const outTiles = outputs.map(([tx, ty]) => ({ tx, ty, data: layer.buffer.writableTile(tx, ty).data }));
    const change: LayerChange = {
      diff,
      offsetBefore: [layer.offsetX, layer.offsetY],
      offsetAfter: [layer.offsetX, layer.offsetY],
    };
    try {
      await services.pixelOps.transformSelectedPixels(this.#setup(layer, selection.data, fill), sources, outTiles);
    } catch (error) {
      diff.undo(doc);
      throw error;
    }
    for (const [tx, ty] of outputs) layer.buffer.markChanged(tx, ty);
    diff.captureAfter(doc);
    changes.push(change);
    this.#selections = { before: selection, after: newMask ? new Selection(newMask) : null };
    doc.setSelection(this.#selections.after);
  }

  #undoChange(c: LayerChange): void {
    const { doc } = this.#ctx;
    c.diff.undo(doc);
    const [offsetX, offsetY] = c.offsetBefore;
    doc.updateLayer(c.diff.layerId, { offsetX, offsetY });
  }

  undo(): void {
    for (const c of [...this.#changes].reverse()) this.#undoChange(c);
    if (this.#selections) this.#ctx.doc.setSelection(this.#selections.before);
  }

  redo(): void {
    const { doc } = this.#ctx;
    for (const c of this.#changes) {
      c.diff.redo(doc);
      const [offsetX, offsetY] = c.offsetAfter;
      doc.updateLayer(c.diff.layerId, { offsetX, offsetY });
    }
    if (this.#selections) doc.setSelection(this.#selections.after);
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const freeTransformCommand: CommandDefinition = {
  name: 'freeTransform',
  isAvailable: (ctx) => transformTargets(ctx.doc).kind !== 'refused',
  create: (ctx, p) => {
    const m = p['matrix'];
    if (!Array.isArray(m) || m.length !== 9 || !m.every(isNum))
      throw new Error('freeTransform: matrix must be 9 numbers');
    const forward = m as unknown as Mat3;
    const inverse = invert(forward);
    if (!inverse) throw new Error('freeTransform: the transform collapses the image');
    const method = p['interpolation'] ?? 'automatic';
    if (!TRANSFORM_METHODS.includes(method as ResampleMethod)) throw new Error('freeTransform: unknown interpolation');
    const color = p['color'];
    if (color !== undefined && (!Array.isArray(color) || !color.every(isNum)))
      throw new Error('freeTransform: color must be a list of numbers');
    const d = p['draft'] as { x?: unknown; y?: unknown; w?: unknown; h?: unknown; step?: unknown } | undefined;
    let draft: { area: Rect; step: number } | undefined;
    if (d !== undefined) {
      if (![d.x, d.y, d.w, d.h, d.step].every(isNum)) throw new Error('freeTransform: draft needs x, y, w, h and step');
      draft = {
        area: { x: d.x as number, y: d.y as number, w: d.w as number, h: d.h as number },
        step: Math.max(1, Math.floor(d.step as number)),
      };
    }
    return new FreeTransformCommand(ctx, forward, inverse, method as ResampleMethod, color, draft);
  },
};
