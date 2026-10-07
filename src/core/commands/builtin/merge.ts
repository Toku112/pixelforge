/**
 * Merging commands: Merge Down, Merge Layers, Merge Group, Merge Visible, Stamp
 * Visible, Flatten Image and Background from Layer. The compositing runs off the
 * main thread (PixelOps.composite); the document only changes once it is done.
 *
 * Behaviour (own summary of the reference app; choices logged in DECISIONS D-025):
 * - Merge Down (Ctrl/Cmd+E with one layer) composites the layer onto the pixel layer
 *   directly below it. The result keeps the lower layer's name, blend mode,
 *   opacity and fill; the upper layer's mode and opacity are baked in. Merging into
 *   the Background gives a Background.
 * - Merge Layers (Ctrl/Cmd+E with several layers) composites the selected layers on
 *   their own into one Normal, 100 % layer named after the topmost, where the topmost
 *   was. Hidden selected layers are discarded. With the Background among them the
 *   result is the Background.
 * - Merge Group (Ctrl/Cmd+E with one group) turns the group into one layer with the
 *   group's name, opacity and blend mode (Pass Through becomes Normal).
 * - Merge Visible merges every visible layer into one (into the Background when it is
 *   visible); hidden layers stay as they are.
 * - Stamp Visible adds a new layer above the active one holding what is visible.
 * - Flatten Image merges everything into a white-backed Background, discarding
 *   hidden layers.
 * - Background from Layer turns the active layer into the Background: moved to the
 *   bottom, transparency filled with a colour (the background colour).
 * Results of merges keep pixels outside the canvas, except Backgrounds and stamps.
 */
import { planFromDocument, type FlattenPlan } from '../../composite/flatten';
import type { ImageDocument } from '../../document/document';
import { EMPTY_RECT, unionRects, type Rect } from '../../document/geometry';
import {
  PixelLayer,
  effectiveLocks,
  layerBounds,
  layerCapabilities,
  type GroupLayer,
  type LayerNode,
} from '../../document/layers';
import { adoptTile, type Tile } from '../../document/tile';
import { TiledBuffer } from '../../document/tiled-buffer';
import { cloneLayer, detach } from '../../history/snapshot';
import { CommandCancelledError, CommandUnavailableError, type CommandContext, type JsonObject } from '../command';
import type { CommandDefinition } from '../registry';
import {
  LayerCommand,
  captureSelection,
  insertionAbove,
  recordPlacements,
  restoreSelection,
  topLevelTargets,
  treeTiles,
  type Placement,
} from './layer-common';

interface Result {
  layer: PixelLayer;
  parentId: string;
  /** Index among the parent's children after the removals. */
  index: number;
}

/** Replaces some layers by one new layer (the merged result); undo restores them. */
abstract class ReplaceLayersCommand extends LayerCommand {
  #removed: (Placement & { copy: LayerNode })[] = [];
  #result: { copy: PixelLayer; parentId: string; index: number } | null = null;

  retainedTiles(): Iterable<Tile> {
    return treeTiles([...this.#removed.map((r) => r.copy), ...(this.#result ? [this.#result.copy] : [])]);
  }

  /** Builds the result off the main thread, then swaps it in for `removeIds` in one go. */
  protected async replace(removeIds: readonly string[], build: () => Promise<Result>): Promise<void> {
    const doc = this.doc;
    this.selectionBefore = captureSelection(doc);
    const result = await build();
    if (this.ctx.task?.cancelled) throw new CommandCancelledError();
    this.#removed = recordPlacements(doc, removeIds).map((p) => ({
      ...p,
      copy: detach(cloneLayer(doc.requireLayer(p.id))),
    }));
    this.#result = {
      copy: detach(cloneLayer(result.layer)) as PixelLayer,
      parentId: result.parentId,
      index: result.index,
    };
    this.redo();
  }

  undo(): void {
    this.doc.removeLayer(this.#result!.copy.id);
    for (const r of this.#removed) this.doc.insertLayer(detach(cloneLayer(r.copy)), r.parentId, r.index);
    restoreSelection(this.doc, this.selectionBefore!);
  }

  redo(): void {
    for (const r of [...this.#removed].reverse()) this.doc.removeLayer(r.id);
    const { copy, parentId, index } = this.#result!;
    this.doc.insertLayer(detach(cloneLayer(copy)), parentId, index);
    this.doc.setActiveLayer(copy.id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isBackground = (l: LayerNode | undefined): l is PixelLayer => l?.kind === 'pixel' && l.isBackground;

/** A layer shows when it and every group containing it are visible. */
function shown(layer: LayerNode): boolean {
  for (let node: LayerNode | GroupLayer | null = layer; node && node.parent; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}

/** `index` in `parentId` once `removed` layers have been taken out. */
function indexAfterRemoval(doc: ImageDocument, parentId: string, index: number, removed: readonly string[]): number {
  const parent = parentId === doc.root.id ? doc.root : (doc.requireLayer(parentId) as GroupLayer);
  return index - parent.children.slice(0, index).filter((c) => removed.includes(c.id)).length;
}

/** Union of the pixel bounds of layers (document coordinates). */
function boundsOf(doc: ImageDocument, layers: readonly LayerNode[]): Rect {
  return layers.reduce((acc, l) => unionRects(acc, layerBounds(l, doc.canvasRect)), EMPTY_RECT);
}

/** Composites `plan` into a new layer buffer (on the document's tile grid). */
async function compositeBuffer(
  ctx: CommandContext,
  plan: FlattenPlan,
  rect: Rect,
  background: { color: readonly number[] } | null,
): Promise<TiledBuffer> {
  const doc = ctx.doc;
  const format = doc.layerFormat(!background);
  const tiles = await ctx.services.pixelOps.composite(
    plan,
    rect,
    format,
    background ? background.color : null,
    ctx.task,
  );
  const buffer = new TiledBuffer(format, { memory: doc.memory, defaultPixel: background?.color });
  for (const t of tiles) buffer.setTile(t.tx, t.ty, adoptTile(t.data, format, doc.memory));
  return buffer;
}

function refuseLocked(doc: ImageDocument, ids: readonly string[]): void {
  const locked = ids.map((id) => doc.requireLayer(id)).find((l) => effectiveLocks(l).all);
  if (locked) throw new CommandUnavailableError(`“${locked.name}” is locked`);
}

// ---------------------------------------------------------------------------
// Merge Down / Merge Layers / Merge Group (Ctrl/Cmd+E)
// ---------------------------------------------------------------------------

type MergeKind = 'down' | 'layers' | 'group';

/** Which merge Ctrl/Cmd+E performs for the current selection, or null if none is possible. */
export function mergeKind(doc: ImageDocument): MergeKind | null {
  const selected = doc.selectedLayerIds;
  if (selected.length > 1) {
    const targets = topLevelTargets(doc, selected);
    return targets.length > 1 && targets.some((id) => shown(doc.requireLayer(id))) ? 'layers' : null;
  }
  const layer = doc.activeLayer;
  if (!layer || !shown(layer)) return null;
  if (layer.kind === 'group') return 'group';
  return layerBelow(doc, layer) ? 'down' : null;
}

/** The visible, editable pixel layer directly below `layer` in its group, if any. */
function layerBelow(doc: ImageDocument, layer: LayerNode): PixelLayer | null {
  if (isBackground(layer)) return null;
  const pos = doc.positionOf(layer.id);
  const parent = layer.parent!;
  const below = parent.children[pos.index - 1];
  if (below?.kind !== 'pixel' || !below.visible || !layerCapabilities(below).editPixels) return null;
  return below;
}

class MergeCommand extends ReplaceLayersCommand {
  readonly label: string;
  readonly descriptor: { name: string; params: JsonObject };
  readonly #kind: MergeKind;

  constructor(ctx: CommandContext, kind: MergeKind) {
    super(ctx);
    this.#kind = kind;
    this.label = kind === 'down' ? 'Merge Down' : kind === 'group' ? 'Merge Group' : 'Merge Layers';
    this.descriptor = { name: 'mergeLayers', params: {} };
  }

  async execute(): Promise<void> {
    const doc = this.doc;
    const kind = mergeKind(doc);
    if (kind !== this.#kind) throw new CommandUnavailableError(`${this.label} is not available for these layers`);
    if (kind === 'down') return this.#mergeDown(doc.activeLayer as PixelLayer);
    if (kind === 'group') return this.#mergeGroup(doc.activeLayer as GroupLayer);
    return this.#mergeLayers(topLevelTargets(doc, doc.selectedLayerIds));
  }

  #mergeDown(upper: PixelLayer): Promise<void> {
    const doc = this.doc;
    const lower = layerBelow(doc, upper)!;
    refuseLocked(doc, [upper.id]);
    const removed = [upper.id, lower.id];
    return this.replace(removed, async () => {
      const plan = planFromDocument(doc, [lower, upper]);
      // The lower layer's own pixels are the backdrop; its properties stay on the result.
      plan.layers[0] = { ...plan.layers[0]!, visible: true, opacity: 1, fillOpacity: 1, blendMode: 'normal' };
      const background = lower.isBackground;
      const rect = background ? doc.canvasRect : boundsOf(doc, [lower, upper]);
      const buffer = await compositeBuffer(
        this.ctx,
        plan,
        rect,
        background ? { color: lower.buffer.defaultPixel } : null,
      );
      const layer = new PixelLayer(lower.id, lower.name, buffer, background);
      if (!background) {
        Object.assign(layer, {
          visible: lower.visible,
          opacity: lower.opacity,
          fillOpacity: lower.fillOpacity,
          blendMode: lower.blendMode,
        });
      }
      const pos = doc.positionOf(lower.id);
      return { layer, parentId: pos.parentId, index: indexAfterRemoval(doc, pos.parentId, pos.index, removed) };
    });
  }

  #mergeGroup(group: GroupLayer): Promise<void> {
    const doc = this.doc;
    refuseLocked(doc, [group.id]);
    return this.replace([group.id], async () => {
      const plan = planFromDocument(doc, group.children);
      const buffer = await compositeBuffer(this.ctx, plan, boundsOf(doc, [group]), null);
      const layer = new PixelLayer(doc.newLayerId(), group.name, buffer);
      Object.assign(layer, {
        opacity: group.opacity,
        fillOpacity: group.fillOpacity,
        blendMode: group.blendMode === 'pass-through' ? 'normal' : group.blendMode,
      });
      const pos = doc.positionOf(group.id);
      return { layer, parentId: pos.parentId, index: pos.index };
    });
  }

  #mergeLayers(targets: string[]): Promise<void> {
    const doc = this.doc;
    refuseLocked(doc, targets);
    const layers = targets.map((id) => doc.requireLayer(id));
    const visible = layers.filter((l) => l.visible);
    const top = visible.at(-1)!;
    const background = layers.find(isBackground);
    return this.replace(targets, async () => {
      // Composited on their own, in stacking order (targets are already ordered).
      const plan = planFromDocument(doc, visible);
      const intoBackground = background !== undefined && background.visible;
      const rect = intoBackground ? doc.canvasRect : boundsOf(doc, visible);
      const buffer = await compositeBuffer(
        this.ctx,
        plan,
        rect,
        intoBackground ? { color: background.buffer.defaultPixel } : null,
      );
      if (intoBackground) {
        return { layer: new PixelLayer(background.id, background.name, buffer, true), parentId: doc.root.id, index: 0 };
      }
      const layer = new PixelLayer(doc.newLayerId(), top.name, buffer);
      const pos = doc.positionOf(top.id);
      return { layer, parentId: pos.parentId, index: indexAfterRemoval(doc, pos.parentId, pos.index, targets) };
    });
  }
}

// ---------------------------------------------------------------------------
// Merge Visible, Stamp Visible, Flatten Image
// ---------------------------------------------------------------------------

/**
 * Layers removed by Merge Visible: whole visible subtrees (a group goes when
 * everything in it is visible; otherwise only its visible contents do).
 */
function visibleSubtrees(nodes: readonly LayerNode[]): LayerNode[] {
  const out: LayerNode[] = [];
  const fully = (l: LayerNode): boolean => l.visible && (l.kind === 'pixel' || l.children.every(fully));
  for (const l of nodes) {
    if (!l.visible) continue;
    if (fully(l)) out.push(l);
    else if (l.kind === 'group') out.push(...visibleSubtrees(l.children));
  }
  return out;
}

const hasVisiblePixels = (doc: ImageDocument) => [...doc.layers()].some((l) => l.kind === 'pixel' && shown(l));

class MergeVisibleCommand extends ReplaceLayersCommand {
  readonly label = 'Merge Visible';
  readonly descriptor = { name: 'mergeVisible', params: {} as JsonObject };

  async execute(): Promise<void> {
    const doc = this.doc;
    if (!hasVisiblePixels(doc)) throw new CommandUnavailableError('No layers are visible');
    const removed = visibleSubtrees(doc.root.children).map((l) => l.id);
    refuseLocked(doc, removed);
    const order = doc.stackOrder();
    removed.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const background = doc.background;
    const intoBackground = !!background && background.visible;
    // The result takes the active layer's name when it is merged, else the topmost merged layer's.
    const active = doc.activeLayer;
    const merged = [...doc.layers()].filter((l) => l.kind === 'pixel' && shown(l));
    const named = active && active.kind === 'pixel' && merged.includes(active) ? active : merged.at(-1)!;
    const anchor = doc.requireLayer(removed.at(-1)!);
    await this.replace(removed, async () => {
      const plan = planFromDocument(doc);
      const rect = intoBackground ? doc.canvasRect : boundsOf(doc, merged);
      const buffer = await compositeBuffer(
        this.ctx,
        plan,
        rect,
        intoBackground ? { color: background.buffer.defaultPixel } : null,
      );
      if (intoBackground) {
        return { layer: new PixelLayer(background.id, background.name, buffer, true), parentId: doc.root.id, index: 0 };
      }
      const pos = doc.positionOf(anchor.id);
      return {
        layer: new PixelLayer(doc.newLayerId(), named.name, buffer),
        parentId: pos.parentId,
        index: indexAfterRemoval(doc, pos.parentId, pos.index, removed),
      };
    });
  }
}

class StampVisibleCommand extends ReplaceLayersCommand {
  readonly label = 'Stamp Visible';
  readonly descriptor = { name: 'stampVisible', params: {} as JsonObject };

  async execute(): Promise<void> {
    const doc = this.doc;
    if (!hasVisiblePixels(doc)) throw new CommandUnavailableError('No layers are visible');
    const place = insertionAbove(doc, doc.activeLayerId);
    const name = doc.nextLayerName();
    await this.replace([], async () => {
      const buffer = await compositeBuffer(this.ctx, planFromDocument(doc), doc.canvasRect, null);
      return { layer: new PixelLayer(doc.newLayerId(), name, buffer), ...place };
    });
  }
}

class FlattenImageCommand extends ReplaceLayersCommand {
  readonly label = 'Flatten Image';
  readonly descriptor = { name: 'flattenImage', params: {} as JsonObject };

  async execute(): Promise<void> {
    const doc = this.doc;
    if (!canFlatten(doc)) throw new CommandUnavailableError('The image is already flat');
    const removed = doc.root.children.map((l) => l.id);
    const background = doc.background;
    await this.replace(removed, async () => {
      const white = doc.whitePixel();
      const buffer = await compositeBuffer(this.ctx, planFromDocument(doc), doc.canvasRect, { color: white });
      const id = background?.id ?? doc.newLayerId();
      return { layer: new PixelLayer(id, 'Background', buffer, true), parentId: doc.root.id, index: 0 };
    });
  }
}

/** Flatten Image is available unless the document is only a Background already. */
function canFlatten(doc: ImageDocument): boolean {
  const only = doc.root.children.length === 1 ? doc.root.children[0] : undefined;
  return doc.root.children.length > 0 && !(isBackground(only) && only.visible);
}

// ---------------------------------------------------------------------------
// Background from Layer
// ---------------------------------------------------------------------------

class BackgroundFromLayerCommand extends ReplaceLayersCommand {
  readonly label = 'Background From Layer';
  readonly descriptor: { name: string; params: JsonObject };
  readonly #color: readonly number[] | undefined;

  constructor(ctx: CommandContext, color: readonly number[] | undefined) {
    super(ctx);
    this.#color = color;
    this.descriptor = { name: 'backgroundFromLayer', params: color ? { color: [...color] } : {} };
  }

  async execute(): Promise<void> {
    const doc = this.doc;
    const layer = doc.activeLayer;
    if (layer?.kind !== 'pixel' || layer.isBackground || doc.background)
      throw new CommandUnavailableError('Select a normal layer in a document without a Background');
    refuseLocked(doc, [layer.id]);
    const color = this.#color ?? doc.whitePixel();
    if (color.length !== doc.colorChannels)
      throw new Error('backgroundFromLayer: color needs one value per colour channel');
    await this.replace([layer.id], async () => {
      const plan = planFromDocument(doc, [layer]);
      plan.layers[0] = { ...plan.layers[0]!, visible: true };
      const buffer = await compositeBuffer(this.ctx, plan, doc.canvasRect, { color });
      const result = new PixelLayer(layer.id, 'Background', buffer, true);
      result.visible = layer.visible;
      return { layer: result, parentId: doc.root.id, index: 0 };
    });
  }
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const mergeCommands: CommandDefinition[] = [
  {
    name: 'mergeLayers',
    isAvailable: (ctx) => mergeKind(ctx.doc) !== null,
    create: (ctx) => {
      const kind = mergeKind(ctx.doc);
      if (!kind) throw new CommandUnavailableError('Nothing to merge');
      return new MergeCommand(ctx, kind);
    },
  },
  {
    name: 'mergeVisible',
    isAvailable: (ctx) => hasVisiblePixels(ctx.doc),
    create: (ctx) => new MergeVisibleCommand(ctx),
  },
  {
    name: 'stampVisible',
    isAvailable: (ctx) => hasVisiblePixels(ctx.doc),
    create: (ctx) => new StampVisibleCommand(ctx),
  },
  { name: 'flattenImage', isAvailable: (ctx) => canFlatten(ctx.doc), create: (ctx) => new FlattenImageCommand(ctx) },
  {
    name: 'backgroundFromLayer',
    isAvailable: (ctx) => {
      const l = ctx.doc.activeLayer;
      return l?.kind === 'pixel' && !l.isBackground && !ctx.doc.background;
    },
    create: (ctx, p) => {
      const color = p['color'];
      if (color !== undefined && (!Array.isArray(color) || !color.every((v) => typeof v === 'number')))
        throw new Error('backgroundFromLayer: color must be a list of numbers');
      return new BackgroundFromLayerCommand(ctx, color);
    },
  },
];
