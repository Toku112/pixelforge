/**
 * Layer structure commands: New Layer, Delete, Duplicate, New Group, Group,
 * Ungroup, reordering (Arrange and drag in the Layers panel) and Layer from
 * Background.
 *
 * Behaviour (own summary of the reference app):
 * - New layers are named "Layer N" and go directly above the active layer, or at
 *   the top inside the active group when that group is expanded.
 * - Deleting selects the layer that was below; a document always keeps one layer.
 * - Duplicates are named "<name> copy", "<name> copy 2"… and sit above their source.
 *   A duplicated Background becomes a normal layer named "Background copy".
 * - Group Layers (Ctrl/Cmd+G) puts the selected layers, in stacking order, into a
 *   new group "Group N" where the topmost of them was. Ungroup moves the children out.
 * - Arrange moves layers within their group; nothing can go below the Background.
 * - Layer from Background turns the Background into a normal layer ("Layer 0")
 *   with transparency; its id stays the same.
 *
 * Undo data are detached copies of the affected layers (sharing frozen tiles), so
 * undo/redo stays correct even after the history restores a snapshot.
 */
import type { ImageDocument } from '../../document/document';
import { GroupLayer, PixelLayer, effectiveLocks, type LayerNode } from '../../document/layers';
import type { Tile } from '../../document/tile';
import { TiledBuffer } from '../../document/tiled-buffer';
import { cloneLayer, detach } from '../../history/snapshot';
import { CommandUnavailableError, type CommandContext, type JsonObject } from '../command';
import type { CommandDefinition } from '../registry';
import {
  LayerCommand,
  applyLayerOptions,
  backgroundToLayerBuffer,
  captureSelection,
  insertionAbove,
  layerOptionParams,
  moveAbove,
  optionalString,
  parseLayerOptions,
  recordPlacements,
  restorePlacements,
  restoreSelection,
  stringArray,
  topLevelTargets,
  treeTiles,
  uniqueCopyName,
  type LayerOptions,
  type Placement,
  type Selection,
} from './layer-common';

// ---------------------------------------------------------------------------
// New Layer
// ---------------------------------------------------------------------------

class NewLayerCommand extends LayerCommand {
  readonly label = 'New Layer';
  readonly descriptor: { name: string; params: JsonObject };
  readonly #options: LayerOptions;
  #id: string | null = null;
  #layerName: string | null = null;
  #place: { parentId: string; index: number } | null = null;

  constructor(ctx: CommandContext, options: LayerOptions) {
    super(ctx);
    this.#options = options;
    this.descriptor = { name: 'newLayer', params: layerOptionParams(options) };
  }

  execute(): void {
    this.selectionBefore = captureSelection(this.doc);
    this.#id ??= this.doc.newLayerId();
    // The number is used up even when the dialog gave another name (as in the reference app).
    if (this.#layerName === null) {
      const numbered = this.doc.nextLayerName();
      this.#layerName = this.#options.name ?? numbered;
    }
    this.#place ??= insertionAbove(this.doc, this.doc.activeLayerId);
    this.redo();
  }

  undo(): void {
    this.doc.removeLayer(this.#id!);
    restoreSelection(this.doc, this.selectionBefore!);
  }

  redo(): void {
    const layer = new PixelLayer(
      this.#id!,
      this.#layerName!,
      new TiledBuffer(this.doc.layerFormat(true), { memory: this.doc.memory }),
    );
    applyLayerOptions(layer, this.#options);
    this.doc.insertLayer(layer, this.#place!.parentId, this.#place!.index);
    this.doc.setActiveLayer(layer.id);
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

class DeleteLayersCommand extends LayerCommand {
  readonly label = 'Delete Layer';
  readonly descriptor: { name: string; params: JsonObject };
  readonly #ids: string[] | undefined;
  #removed: (Placement & { copy: LayerNode })[] = [];
  #selectionAfter: Selection = { ids: [], active: null };

  constructor(ctx: CommandContext, ids: string[] | undefined) {
    super(ctx);
    this.#ids = ids;
    this.descriptor = { name: 'deleteLayers', params: ids ? { layerIds: ids } : {} };
  }

  retainedTiles(): Iterable<Tile> {
    return treeTiles(this.#removed.map((r) => r.copy));
  }

  execute(): void {
    const doc = this.doc;
    const targets = topLevelTargets(doc, this.#ids);
    if (targets.length === 0) throw new CommandUnavailableError('No layer is selected');
    const locked = targets.find((id) => effectiveLocks(doc.requireLayer(id)).all);
    if (locked) throw new CommandUnavailableError(`“${doc.requireLayer(locked).name}” is locked`);
    const remaining = doc.root.children.filter((l) => !targets.includes(l.id)).length;
    if (remaining === 0) throw new CommandUnavailableError('A document must keep at least one layer');

    this.selectionBefore = captureSelection(doc);
    this.#removed = recordPlacements(doc, targets).map((p) => ({
      ...p,
      copy: detach(cloneLayer(doc.requireLayer(p.id))),
    }));
    // Afterwards, select the layer below the lowest deleted one (or above, or its group).
    const lowest = this.#removed[0]!;
    const siblings =
      doc.getLayer(lowest.parentId)?.kind === 'group'
        ? (doc.requireLayer(lowest.parentId) as GroupLayer).children
        : doc.root.children;
    const survivors = siblings.filter((l) => !targets.includes(l.id));
    const below = siblings
      .slice(0, lowest.index)
      .reverse()
      .find((l) => !targets.includes(l.id));
    const next =
      below ??
      survivors[0] ??
      (lowest.parentId !== doc.root.id ? doc.getLayer(lowest.parentId) : undefined) ??
      doc.root.children.find((l) => !targets.includes(l.id));
    this.#selectionAfter = { ids: next ? [next.id] : [], active: next?.id ?? null };
    this.redo();
  }

  undo(): void {
    for (const r of this.#removed) this.doc.insertLayer(detach(cloneLayer(r.copy)), r.parentId, r.index);
    restoreSelection(this.doc, this.selectionBefore!);
  }

  redo(): void {
    for (const r of [...this.#removed].reverse()) this.doc.removeLayer(r.id);
    restoreSelection(this.doc, this.#selectionAfter);
  }
}

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

class DuplicateLayersCommand extends LayerCommand {
  readonly label = 'Duplicate Layer';
  readonly descriptor: { name: string; params: JsonObject };
  readonly #ids: string[] | undefined;
  readonly #name: string | undefined;
  #copies: (Placement & { copy: LayerNode })[] = [];

  constructor(ctx: CommandContext, ids: string[] | undefined, name: string | undefined) {
    super(ctx);
    this.#ids = ids;
    this.#name = name;
    const params: JsonObject = {};
    if (ids) params['layerIds'] = ids;
    if (name !== undefined) params['name'] = name;
    this.descriptor = { name: 'duplicateLayers', params };
  }

  retainedTiles(): Iterable<Tile> {
    return treeTiles(this.#copies.map((c) => c.copy));
  }

  async execute(): Promise<void> {
    const doc = this.doc;
    const targets = topLevelTargets(doc, this.#ids);
    if (targets.length === 0) throw new CommandUnavailableError('No layer is selected');
    this.selectionBefore = captureSelection(doc);

    // Build every copy first (converting a Background needs the worker), then insert.
    if (this.#name !== undefined && targets.length > 1) throw new Error('duplicateLayers: a name needs a single layer');
    const taken = new Set<string>();
    const built: { sourceId: string; layer: LayerNode }[] = [];
    for (const id of targets) {
      const source = doc.requireLayer(id);
      const name = this.#name ?? uniqueCopyName(doc, source.name, taken);
      let layer: LayerNode;
      if (source.kind === 'pixel' && source.isBackground) {
        layer = new PixelLayer(doc.newLayerId(), name, await backgroundToLayerBuffer(doc, source, this.ctx.services));
        layer.visible = source.visible;
      } else {
        layer = cloneLayer(source, () => doc.newLayerId());
        layer.name = name;
      }
      built.push({ sourceId: id, layer });
    }
    this.#copies = [];
    for (const { sourceId, layer } of built) {
      const pos = doc.positionOf(sourceId);
      doc.insertLayer(layer, pos.parentId, pos.index + 1);
      this.#copies.push({
        id: layer.id,
        parentId: pos.parentId,
        index: pos.index + 1,
        copy: detach(cloneLayer(layer)),
      });
    }
    doc.selectLayers(this.#copies.map((c) => c.id));
  }

  undo(): void {
    for (const c of [...this.#copies].reverse()) this.doc.removeLayer(c.id);
    restoreSelection(this.doc, this.selectionBefore!);
  }

  redo(): void {
    for (const c of this.#copies) this.doc.insertLayer(detach(cloneLayer(c.copy)), c.parentId, c.index);
    this.doc.selectLayers(this.#copies.map((c) => c.id));
  }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

class NewGroupCommand extends LayerCommand {
  readonly label = 'New Group';
  readonly descriptor: { name: string; params: JsonObject };
  readonly #options: LayerOptions;
  #id: string | null = null;
  #groupName: string | null = null;
  #place: { parentId: string; index: number } | null = null;

  constructor(ctx: CommandContext, options: LayerOptions) {
    super(ctx);
    this.#options = options;
    this.descriptor = { name: 'newGroup', params: layerOptionParams(options) };
  }

  execute(): void {
    this.selectionBefore = captureSelection(this.doc);
    this.#id ??= this.doc.newLayerId();
    if (this.#groupName === null) {
      const numbered = this.doc.nextGroupName();
      this.#groupName = this.#options.name ?? numbered;
    }
    this.#place ??= insertionAbove(this.doc, this.doc.activeLayerId);
    this.redo();
  }

  undo(): void {
    this.doc.removeLayer(this.#id!);
    restoreSelection(this.doc, this.selectionBefore!);
  }

  redo(): void {
    const group = new GroupLayer(this.#id!, this.#groupName!);
    applyLayerOptions(group, this.#options);
    this.doc.insertLayer(group, this.#place!.parentId, this.#place!.index);
    this.doc.setActiveLayer(this.#id);
  }
}

class GroupLayersCommand extends LayerCommand {
  readonly label = 'Group Layers';
  readonly descriptor: { name: string; params: JsonObject };
  readonly #ids: string[] | undefined;
  readonly #options: LayerOptions;
  #groupId: string | null = null;
  #groupName: string | null = null;
  #placements: Placement[] = [];

  constructor(ctx: CommandContext, ids: string[] | undefined, options: LayerOptions) {
    super(ctx);
    this.#ids = ids;
    this.#options = options;
    const params: JsonObject = layerOptionParams(options);
    if (ids) params['layerIds'] = ids;
    this.descriptor = { name: 'groupLayers', params };
  }

  execute(): void {
    const doc = this.doc;
    const targets = topLevelTargets(doc, this.#ids);
    if (targets.length === 0) throw new CommandUnavailableError('No layer is selected');
    if (
      targets.some((id) => {
        const l = doc.requireLayer(id);
        return l.kind === 'pixel' && l.isBackground;
      })
    ) {
      throw new CommandUnavailableError('The Background layer cannot be put in a group');
    }
    this.selectionBefore = captureSelection(doc);
    this.#placements = recordPlacements(doc, targets);
    this.#groupId ??= doc.newLayerId();
    if (this.#groupName === null) {
      const numbered = doc.nextGroupName();
      this.#groupName = this.#options.name ?? numbered;
    }
    this.redo();
  }

  undo(): void {
    restorePlacements(this.doc, this.#placements);
    this.doc.removeLayer(this.#groupId!);
    restoreSelection(this.doc, this.selectionBefore!);
  }

  redo(): void {
    const top = this.#placements.at(-1)!;
    const group = new GroupLayer(this.#groupId!, this.#groupName!);
    applyLayerOptions(group, this.#options);
    this.doc.insertLayer(group, top.parentId, this.doc.positionOf(top.id).index + 1);
    for (const p of this.#placements) this.doc.moveLayer(p.id, group.id, group.children.length);
    this.doc.setActiveLayer(group.id);
  }
}

class UngroupCommand extends LayerCommand {
  readonly label = 'Ungroup Layers';
  readonly descriptor: { name: string; params: JsonObject };
  readonly #groupIdParam: string | undefined;
  #group: GroupLayer | null = null;
  #place: { parentId: string; index: number } | null = null;
  #children: string[] = [];

  constructor(ctx: CommandContext, groupId: string | undefined) {
    super(ctx);
    this.#groupIdParam = groupId;
    this.descriptor = { name: 'ungroup', params: groupId ? { groupId } : {} };
  }

  execute(): void {
    const doc = this.doc;
    const id = this.#groupIdParam ?? doc.activeLayerId;
    const group = id ? doc.getLayer(id) : undefined;
    if (group?.kind !== 'group') throw new CommandUnavailableError('Select a group to ungroup');
    this.selectionBefore = captureSelection(doc);
    // Keep the group's own properties for undo (children are restored by moving them back).
    const shell = new GroupLayer(group.id, group.name);
    Object.assign(shell, {
      visible: group.visible,
      opacity: group.opacity,
      fillOpacity: group.fillOpacity,
      blendMode: group.blendMode,
      locks: group.locks,
      expanded: group.expanded,
    });
    this.#group = shell;
    this.#place = doc.positionOf(group.id);
    this.#children = group.children.map((c) => c.id);
    this.redo();
  }

  undo(): void {
    const g = this.#group!;
    const shell = new GroupLayer(g.id, g.name);
    Object.assign(shell, {
      visible: g.visible,
      opacity: g.opacity,
      fillOpacity: g.fillOpacity,
      blendMode: g.blendMode,
      locks: g.locks,
      expanded: g.expanded,
    });
    this.doc.insertLayer(shell, this.#place!.parentId, this.doc.positionOf(this.#children[0]!).index);
    for (const id of this.#children) this.doc.moveLayer(id, shell.id, shell.children.length);
    restoreSelection(this.doc, this.selectionBefore!);
  }

  redo(): void {
    const { parentId, index } = this.doc.positionOf(this.#group!.id);
    this.#children.forEach((id, i) => this.doc.moveLayer(id, parentId, index + 1 + i));
    this.doc.removeLayer(this.#group!.id);
    this.doc.selectLayers(this.#children);
  }
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

export type ArrangeMode = 'front' | 'forward' | 'backward' | 'back';
const ARRANGE_MODES: readonly ArrangeMode[] = ['front', 'forward', 'backward', 'back'];

class ReorderCommand extends LayerCommand {
  readonly label = 'Layer Order';
  readonly descriptor: { name: string; params: JsonObject };
  readonly #ids: string[] | undefined;
  readonly #apply: (doc: ImageDocument, targets: string[]) => void;
  #before: Placement[] = [];
  #after: Placement[] = [];

  constructor(
    ctx: CommandContext,
    ids: string[] | undefined,
    descriptorParams: JsonObject,
    name: string,
    apply: (doc: ImageDocument, targets: string[]) => void,
  ) {
    super(ctx);
    this.#ids = ids;
    this.#apply = apply;
    this.descriptor = { name, params: { ...descriptorParams, ...(ids ? { layerIds: ids } : {}) } };
  }

  execute(): void {
    const doc = this.doc;
    const targets = topLevelTargets(doc, this.#ids);
    if (targets.length === 0) throw new CommandUnavailableError('No layer is selected');
    if (
      targets.some((id) => {
        const l = doc.requireLayer(id);
        return l.kind === 'pixel' && l.isBackground;
      })
    ) {
      throw new CommandUnavailableError('The Background layer cannot be moved');
    }
    this.#before = recordPlacements(doc, targets);
    this.#apply(doc, targets);
    this.#after = recordPlacements(doc, targets);
  }

  undo(): void {
    restorePlacements(this.doc, this.#before);
  }

  redo(): void {
    restorePlacements(this.doc, this.#after);
  }
}

/** Arrange within each layer's group, keeping selected siblings together; the Background stays at the bottom. */
function arrange(doc: ImageDocument, targets: string[], mode: ArrangeMode): void {
  const byParent = new Map<string, string[]>();
  for (const id of targets) {
    const parent = doc.positionOf(id).parentId;
    byParent.set(parent, [...(byParent.get(parent) ?? []), id]);
  }
  for (const [parentId, ids] of byParent) {
    const parent = parentId === doc.root.id ? doc.root : (doc.requireLayer(parentId) as GroupLayer);
    const floor = parent === doc.root && doc.background ? 1 : 0;
    const order = parent.children.map((c) => c.id);
    const selected = new Set(ids);
    let next: string[];
    if (mode === 'front' || mode === 'back') {
      const rest = order.filter((id) => !selected.has(id));
      const moving = order.filter((id) => selected.has(id));
      next = mode === 'front' ? [...rest, ...moving] : [...rest.slice(0, floor), ...moving, ...rest.slice(floor)];
    } else {
      next = [...order];
      const step = mode === 'forward' ? 1 : -1;
      const indices = next.map((id, i) => (selected.has(id) ? i : -1)).filter((i) => i >= 0);
      if (step === 1) indices.reverse();
      for (const i of indices) {
        const j = i + step;
        if (j < floor || j >= next.length || selected.has(next[j]!)) continue;
        [next[i], next[j]] = [next[j]!, next[i]!];
      }
    }
    // Place in final order from the bottom; each step only moves one layer upwards into place.
    next.forEach((id, i) => {
      if (doc.positionOf(id).index !== i) doc.moveLayer(id, parentId, i);
    });
  }
}

// ---------------------------------------------------------------------------
// Layer from Background
// ---------------------------------------------------------------------------

class LayerFromBackgroundCommand extends LayerCommand {
  readonly label = 'Layer From Background';
  readonly descriptor: { name: string; params: JsonObject };
  readonly #options: LayerOptions;
  #before: LayerNode | null = null;
  #after: LayerNode | null = null;

  constructor(ctx: CommandContext, options: LayerOptions) {
    super(ctx);
    this.#options = options;
    this.descriptor = { name: 'layerFromBackground', params: layerOptionParams(options) };
  }

  retainedTiles(): Iterable<Tile> {
    return treeTiles([this.#before, this.#after].filter((l): l is LayerNode => l !== null));
  }

  async execute(): Promise<void> {
    const doc = this.doc;
    const background = doc.background;
    if (!background) throw new CommandUnavailableError('The document has no Background layer');
    this.selectionBefore = captureSelection(doc);
    const layer = new PixelLayer(
      background.id,
      this.#options.name ?? 'Layer 0',
      await backgroundToLayerBuffer(doc, background, this.ctx.services),
    );
    layer.visible = background.visible;
    applyLayerOptions(layer, this.#options);
    this.#before = detach(cloneLayer(background));
    doc.removeLayer(background.id);
    doc.insertLayer(layer, doc.root.id, 0);
    this.#after = detach(cloneLayer(layer));
    doc.setActiveLayer(layer.id);
  }

  undo(): void {
    this.#swap(this.#before!);
    restoreSelection(this.doc, this.selectionBefore!);
  }

  redo(): void {
    this.#swap(this.#after!);
    this.doc.setActiveLayer(this.#after!.id);
  }

  #swap(layer: LayerNode): void {
    this.doc.removeLayer(layer.id);
    this.doc.insertLayer(detach(cloneLayer(layer)), this.doc.root.id, 0);
  }
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const hasSelection = (ctx: CommandContext) => ctx.doc.selectedLayerIds.length > 0;
const selectionIsMovable = (ctx: CommandContext) =>
  hasSelection(ctx) &&
  !ctx.doc.selectedLayerIds.some((id) => {
    const l = ctx.doc.getLayer(id);
    return l?.kind === 'pixel' && l.isBackground;
  });

export const layerCommands: CommandDefinition[] = [
  { name: 'newLayer', create: (ctx, p) => new NewLayerCommand(ctx, parseLayerOptions(p, false)) },
  {
    name: 'deleteLayers',
    isAvailable: (ctx) =>
      hasSelection(ctx) &&
      ctx.doc.root.children.some((l) => !ctx.doc.selectedLayerIds.includes(l.id)) &&
      !ctx.doc.selectedLayerIds.some((id) => {
        const l = ctx.doc.getLayer(id);
        return l !== undefined && effectiveLocks(l).all;
      }),
    create: (ctx, p) => new DeleteLayersCommand(ctx, stringArray(p['layerIds'], 'layerIds')),
  },
  {
    name: 'duplicateLayers',
    isAvailable: hasSelection,
    create: (ctx, p) =>
      new DuplicateLayersCommand(ctx, stringArray(p['layerIds'], 'layerIds'), optionalString(p['name'], 'name')),
  },
  { name: 'newGroup', create: (ctx, p) => new NewGroupCommand(ctx, parseLayerOptions(p, true)) },
  {
    name: 'groupLayers',
    isAvailable: selectionIsMovable,
    create: (ctx, p) => new GroupLayersCommand(ctx, stringArray(p['layerIds'], 'layerIds'), parseLayerOptions(p, true)),
  },
  {
    name: 'ungroup',
    isAvailable: (ctx) => ctx.doc.activeLayer?.kind === 'group',
    create: (ctx, p) => new UngroupCommand(ctx, optionalString(p['groupId'], 'groupId')),
  },
  {
    name: 'arrangeLayers',
    isAvailable: selectionIsMovable,
    create: (ctx, p) => {
      const mode = p['mode'];
      if (typeof mode !== 'string' || !ARRANGE_MODES.includes(mode as ArrangeMode))
        throw new Error('arrangeLayers: mode must be front, forward, backward or back');
      return new ReorderCommand(
        ctx,
        stringArray(p['layerIds'], 'layerIds'),
        { mode },
        'arrangeLayers',
        (doc, targets) => arrange(doc, targets, mode as ArrangeMode),
      );
    },
  },
  {
    name: 'moveLayers',
    isAvailable: selectionIsMovable,
    create: (ctx, p) => {
      const parentId = p['parentId'];
      const index = p['index'];
      if (typeof parentId !== 'string' || typeof index !== 'number' || !Number.isInteger(index) || index < 0)
        throw new Error('moveLayers: parentId and a whole index are required');
      return new ReorderCommand(
        ctx,
        stringArray(p['layerIds'], 'layerIds'),
        { parentId, index },
        'moveLayers',
        (doc, targets) => {
          // `index` counts the target group's children without the moving layers.
          const parent = parentId === doc.root.id ? doc.root : doc.requireLayer(parentId);
          if (parent.kind !== 'group') throw new Error('moveLayers: target is not a group');
          if (targets.some((id) => parentId !== doc.root.id && doc.isWithin(parentId, id)))
            throw new CommandUnavailableError('A group cannot be moved into itself');
          const others = parent.children.filter((c) => !targets.includes(c.id));
          let anchor = others[index - 1]?.id ?? null; // insert above this layer (null = at the bottom)
          for (const id of targets) {
            moveAbove(doc, id, parentId, anchor);
            anchor = id;
          }
        },
      );
    },
  },
  {
    name: 'layerFromBackground',
    isAvailable: (ctx) => !!ctx.doc.background,
    create: (ctx, p) => new LayerFromBackgroundCommand(ctx, parseLayerOptions(p, false)),
  },
];
