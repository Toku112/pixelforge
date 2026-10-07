/**
 * Shared pieces of the layer structure commands (layers.ts, merge.ts): selection
 * capture/restore, placements, target lists, option parsing and the base class.
 */
import type { ImageDocument } from '../../document/document';
import { LAYER_BLEND_MODES, type BlendMode, type LayerNode, type PixelLayer } from '../../document/layers';
import { adoptTile, allocateTile, type Tile } from '../../document/tile';
import { TiledBuffer } from '../../document/tiled-buffer';
import { layerTreeTiles } from '../../history/snapshot';
import type { Command, CommandContext, CommandServices, JsonObject } from '../command';
import { wholeLayerTiles } from '../pixel-targets';

export interface Selection {
  ids: string[];
  active: string | null;
}

export function captureSelection(doc: ImageDocument): Selection {
  return { ids: [...doc.selectedLayerIds], active: doc.activeLayerId };
}

export function restoreSelection(doc: ImageDocument, sel: Selection): void {
  const ids = sel.ids.filter((id) => doc.getLayer(id));
  doc.selectLayers(ids, sel.active && ids.includes(sel.active) ? sel.active : (ids.at(-1) ?? null));
}

/** Name, blend mode and opacity chosen in the New Layer / New Group dialogs. */
export interface LayerOptions {
  name?: string;
  blendMode?: BlendMode;
  opacity?: number;
}

export function parseLayerOptions(p: JsonObject, allowPassThrough: boolean): LayerOptions {
  const options: LayerOptions = {};
  const name = optionalString(p['name'], 'name');
  if (name !== undefined) options.name = name;
  const mode = p['blendMode'];
  if (mode !== undefined) {
    const valid =
      (allowPassThrough && mode === 'pass-through') || (LAYER_BLEND_MODES as readonly unknown[]).includes(mode);
    if (!valid) throw new Error('blendMode is not a valid blend mode');
    options.blendMode = mode as BlendMode;
  }
  const opacity = p['opacity'];
  if (opacity !== undefined) {
    if (typeof opacity !== 'number' || !(opacity >= 0 && opacity <= 1))
      throw new Error('opacity must be between 0 and 1');
    options.opacity = opacity;
  }
  return options;
}

export function layerOptionParams(options: LayerOptions): JsonObject {
  const params: JsonObject = {};
  if (options.name !== undefined) params['name'] = options.name;
  if (options.blendMode !== undefined) params['blendMode'] = options.blendMode;
  if (options.opacity !== undefined) params['opacity'] = options.opacity;
  return params;
}

export function applyLayerOptions(layer: LayerNode, options: LayerOptions): void {
  if (options.blendMode !== undefined) layer.blendMode = options.blendMode;
  if (options.opacity !== undefined) layer.opacity = options.opacity;
}

export function stringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw new Error(`${name} must be a list of layer ids`);
  return value;
}

/** The given layers (default: the selection), without those inside another one of them, in stacking order. */
export function topLevelTargets(doc: ImageDocument, ids: readonly string[] | undefined): string[] {
  const wanted = new Set(ids ?? doc.selectedLayerIds);
  for (const id of wanted) doc.requireLayer(id);
  const order = doc.stackOrder();
  return order.filter((id) => wanted.has(id) && ![...wanted].some((other) => other !== id && doc.isWithin(id, other)));
}

/** Where a new layer goes: above the active layer, or at the top of the active group when it is expanded. */
export function insertionAbove(doc: ImageDocument, layerId: string | null): { parentId: string; index: number } {
  const layer = layerId ? doc.getLayer(layerId) : undefined;
  if (!layer) return { parentId: doc.root.id, index: doc.root.children.length };
  if (layer.kind === 'group' && layer.expanded) return { parentId: layer.id, index: layer.children.length };
  const pos = doc.positionOf(layer.id);
  return { parentId: pos.parentId, index: pos.index + 1 };
}

export interface Placement {
  id: string;
  parentId: string;
  index: number;
}

/** Records positions; restores them in stacking order (safe across parents). */
export function recordPlacements(doc: ImageDocument, ids: readonly string[]): Placement[] {
  const order = doc.stackOrder();
  return ids.map((id) => ({ id, ...doc.positionOf(id) })).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

export function restorePlacements(doc: ImageDocument, placements: readonly Placement[]): void {
  for (const p of placements) doc.moveLayer(p.id, p.parentId, p.index);
}

/**
 * Moves a layer into `parentId` directly above `anchorId` (or to the bottom — above
 * the Background, if any — when the anchor is null).
 */
export function moveAbove(doc: ImageDocument, id: string, parentId: string, anchorId: string | null): void {
  if (anchorId === null) {
    doc.moveLayer(id, parentId, parentId === doc.root.id && doc.background ? 1 : 0);
    return;
  }
  const anchor = doc.positionOf(anchorId);
  const moving = doc.positionOf(id);
  // moveLayer counts positions without the moving layer.
  const index = anchor.index + 1 - (moving.parentId === parentId && moving.index < anchor.index ? 1 : 0);
  doc.moveLayer(id, parentId, index);
}

/** The name a duplicate of a layer named `base` gets ("Sky copy", "Sky copy 2"…). */
export function suggestedCopyName(doc: ImageDocument, base: string): string {
  return uniqueCopyName(doc, base, new Set());
}

export function uniqueCopyName(doc: ImageDocument, base: string, taken: Set<string>): string {
  for (const l of doc.layers()) taken.add(l.name);
  let name = `${base} copy`;
  for (let n = 2; taken.has(name); n++) name = `${base} copy ${n}`;
  taken.add(name);
  return name;
}

/**
 * A normal-layer buffer (with alpha) holding the Background's pixels: every
 * allocated tile and every tile of the canvas, converted off the main thread.
 */
export async function backgroundToLayerBuffer(
  doc: ImageDocument,
  background: PixelLayer,
  services: CommandServices,
): Promise<TiledBuffer> {
  const from = background.buffer.format;
  const to = { ...from, hasAlpha: true };
  const coords = wholeLayerTiles(doc, background);
  const sources = coords.map(
    ([tx, ty]) =>
      background.buffer.getTile(tx, ty)?.data ??
      allocateTile(from, { allocate: (n) => new ArrayBuffer(n) }, background.buffer.defaultPixel).data,
  );
  const converted = await services.pixelOps.convertAlpha(sources, from, to, []);
  const buffer = new TiledBuffer(to, { memory: doc.memory });
  coords.forEach(([tx, ty], i) => buffer.setTile(tx, ty, adoptTile(converted[i]!, to, doc.memory)));
  return buffer;
}

export function treeTiles(layers: Iterable<LayerNode>): Tile[] {
  const tiles: Tile[] = [];
  for (const layer of layers) tiles.push(...layerTreeTiles(layer));
  return tiles;
}

export abstract class LayerCommand implements Command {
  abstract readonly label: string;
  abstract readonly descriptor: { name: string; params: JsonObject };
  readonly undoBytes = 0;
  protected readonly ctx: CommandContext;
  protected selectionBefore: Selection | null = null;

  constructor(ctx: CommandContext) {
    this.ctx = ctx;
  }

  get doc(): ImageDocument {
    return this.ctx.doc;
  }

  abstract execute(): void | Promise<void>;
  abstract undo(): void;
  abstract redo(): void;
}

export function optionalString(v: unknown, name: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`${name} must be a string`);
  return v;
}
