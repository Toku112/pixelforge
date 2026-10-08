/**
 * The document model: canvas properties plus the layer tree.
 *
 * The mutation methods here are low-level primitives for Commands (CLAUDE.md §3.2):
 * UI code must change documents only by executing commands, so that every change
 * is undoable, recordable and journaled. Every primitive emits a change event that
 * the renderer and panels use to update.
 */
import type { Selection } from '../selection/selection';
import type { Symmetry } from '../paint/symmetry';
import { Emitter } from './events';
import { isEmptyRect, type Rect } from './geometry';
import {
  GroupLayer,
  PixelLayer,
  layerCapabilities,
  type GroupLayerProps,
  type LayerNode,
  type PixelLayerProps,
} from './layers';
import { colorChannelCount, maxSampleValue, type BitDepth, type ColorMode, type PixelFormat } from './pixel-format';
import { TILE_SIZE, TileNotResidentError, heapTileMemory, type TileMemory } from './tile';
import { TiledBuffer } from './tiled-buffer';

export type DocumentChange =
  /** Pixels of a layer changed inside `rect` (document coordinates, tile-aligned). */
  | { kind: 'pixels'; layerId: string; rect: Rect }
  /** A layer property (visibility, opacity, blend mode, name, offset, locks…) changed. */
  | { kind: 'layer'; layerId: string; props: readonly string[] }
  /** Layers were inserted, removed or reordered. */
  | { kind: 'structure' }
  /** Canvas size, resolution, colour mode or bit depth changed. */
  | { kind: 'canvas' }
  /** The active layer or the set of selected layers changed. */
  | { kind: 'active-layer'; layerId: string | null }
  /** The pixel selection (marching ants) changed. */
  | { kind: 'selection' }
  /** The paint symmetry changed. */
  | { kind: 'symmetry' };

/** Canvas-level properties (changed by Image Size, Canvas Size, Mode conversions…). */
export interface CanvasProps {
  width: number;
  height: number;
  resolution: number;
  mode: ColorMode;
  depth: BitDepth;
  multichannelCount: number;
}

export interface DocumentInit {
  width: number;
  height: number;
  name?: string;
  mode?: ColorMode;
  depth?: BitDepth;
  /** Pixels per inch. */
  resolution?: number;
  /** Channel count for multichannel mode. */
  multichannelCount?: number;
  memory?: TileMemory;
}

/** Largest supported canvas side, in pixels (the PSB format's limit). */
export const MAX_DOCUMENT_SIDE = 300_000;

let nextDocumentNumber = 1;

/** Layers entering a document must have all their pixels in memory. */
function assertResident(layer: LayerNode): void {
  if (layer.kind === 'group') {
    layer.children.forEach(assertResident);
    return;
  }
  for (const [, , tile] of layer.buffer.tiles()) if (!tile.resident) throw new TileNotResidentError(tile.id);
}

function checkCanvasSize(width: number, height: number): void {
  for (const [label, side] of [
    ['width', width],
    ['height', height],
  ] as const) {
    if (!Number.isInteger(side) || side < 1 || side > MAX_DOCUMENT_SIDE) {
      throw new Error(`Document ${label} must be an integer from 1 to ${MAX_DOCUMENT_SIDE}, got ${side}`);
    }
  }
}

export class ImageDocument {
  /** Session-unique identifier. */
  readonly id = `doc-${nextDocumentNumber++}`;
  name: string;
  width: number;
  height: number;
  resolution: number;
  mode: ColorMode;
  depth: BitDepth;
  multichannelCount: number;
  /**
   * Embedded ICC profile bytes kept from the opened file, written back on save.
   * (Colour management that uses it arrives in Phase 7.)
   */
  iccProfile: Uint8Array | null = null;
  readonly memory: TileMemory;
  /** Invisible container of the top-level layers. */
  readonly root: GroupLayer;
  readonly changes = new Emitter<DocumentChange>();

  #activeLayerId: string | null = null;
  /** Selected layers in selection order (the active layer is one of them). */
  #selectedIds: string[] = [];
  #selection: Selection | null = null;
  #reselect: Selection | null = null;
  #symmetry: Symmetry | null = null;
  #nextGroupNumber = 1;
  #nextLayerId = 1;
  #nextLayerNumber = 1;
  readonly #layersById = new Map<string, LayerNode>();
  readonly #unsubscribe = new Map<string, () => void>();

  constructor(init: DocumentInit) {
    checkCanvasSize(init.width, init.height);
    this.name = init.name ?? 'Untitled';
    this.width = init.width;
    this.height = init.height;
    this.resolution = init.resolution ?? 72;
    this.mode = init.mode ?? 'rgb';
    this.depth = init.depth ?? 8;
    this.multichannelCount = init.multichannelCount ?? 1;
    this.memory = init.memory ?? heapTileMemory;
    this.root = new GroupLayer('root', '');
  }

  canvasProps(): CanvasProps {
    const { width, height, resolution, mode, depth, multichannelCount } = this;
    return { width, height, resolution, mode, depth, multichannelCount };
  }

  get canvasRect(): Rect {
    return { x: 0, y: 0, w: this.width, h: this.height };
  }

  /** The pixel selection, or null when nothing is selected (the whole layer is the target). */
  get selection(): Selection | null {
    return this.#selection;
  }

  /** The paint symmetry (its guide, and whether it is on), or null. */
  get symmetry(): Symmetry | null {
    return this.#symmetry;
  }

  /** Replaces the paint symmetry; returns the previous one for undo. */
  setSymmetry(symmetry: Symmetry | null): Symmetry | null {
    const previous = this.#symmetry;
    this.#symmetry = symmetry ? Object.freeze({ ...symmetry }) : null;
    this.changes.emit({ kind: 'symmetry' });
    return previous;
  }

  /** The selection Select > Reselect brings back (the last one removed by Deselect). */
  get reselectable(): Selection | null {
    return this.#reselect;
  }

  /** Replaces the selection (and the Reselect memory); returns the previous values for undo. */
  setSelection(
    selection: Selection | null,
    reselect: Selection | null = this.#reselect,
  ): { selection: Selection | null; reselect: Selection | null } {
    const previous = { selection: this.#selection, reselect: this.#reselect };
    this.#selection = selection;
    this.#reselect = reselect;
    if (previous.selection !== selection) this.changes.emit({ kind: 'selection' });
    return previous;
  }

  get colorChannels(): number {
    return colorChannelCount(this.mode, this.multichannelCount);
  }

  /** Pixel format of layers in this document (Background layers have no alpha). */
  layerFormat(hasAlpha = true): PixelFormat {
    return { depth: this.depth, colorChannels: this.colorChannels, hasAlpha };
  }

  /**
   * White in this document's colour mode, as interleaved samples (without alpha).
   * Encodings (docs/FORMAT_NOTES.md §1.2): CMYK samples are ink amounts (0 = no ink);
   * the Lab a and b channels are stored offset so that neutral is mid-scale (128 / 32768).
   */
  whitePixel(): number[] {
    const max = maxSampleValue(this.depth);
    switch (this.mode) {
      case 'cmyk':
        return [0, 0, 0, 0];
      case 'lab': {
        const neutral = this.depth === 8 ? 128 : 32768;
        return [max, neutral, neutral];
      }
      case 'indexed':
        throw new Error('White depends on the colour table in Indexed Color mode');
      default:
        return new Array<number>(this.colorChannels).fill(max);
    }
  }

  // ---------------------------------------------------------------------------
  // Layer creation (not yet inserted)
  // ---------------------------------------------------------------------------

  newLayerId(): string {
    return `L${this.#nextLayerId++}`;
  }

  /** Default name for the next new layer: "Layer 1", "Layer 2", … */
  nextLayerName(): string {
    return `Layer ${this.#nextLayerNumber++}`;
  }

  /** The name `nextLayerName()` would return, without using it up (dialog defaults). */
  peekLayerName(): string {
    return `Layer ${this.#nextLayerNumber}`;
  }

  createPixelLayer(name = this.nextLayerName()): PixelLayer {
    const buffer = new TiledBuffer(this.layerFormat(true), { memory: this.memory });
    return new PixelLayer(this.newLayerId(), name, buffer);
  }

  /** A Background layer filled with `color` (colour samples, no alpha; default white). */
  createBackgroundLayer(color: ArrayLike<number> = this.whitePixel()): PixelLayer {
    const buffer = new TiledBuffer(this.layerFormat(false), { memory: this.memory, defaultPixel: color });
    return new PixelLayer(this.newLayerId(), 'Background', buffer, true);
  }

  /** Default name for the next new group: "Group 1", "Group 2", … */
  nextGroupName(): string {
    return `Group ${this.#nextGroupNumber++}`;
  }

  /** The name `nextGroupName()` would return, without using it up. */
  peekGroupName(): string {
    return `Group ${this.#nextGroupNumber}`;
  }

  createGroup(name = this.nextGroupName()): GroupLayer {
    return new GroupLayer(this.newLayerId(), name);
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  getLayer(id: string): LayerNode | undefined {
    return this.#layersById.get(id);
  }

  requireLayer(id: string): LayerNode {
    const layer = this.#layersById.get(id);
    if (!layer) throw new Error(`No layer with id ${id}`);
    return layer;
  }

  requirePixelLayer(id: string): PixelLayer {
    const layer = this.requireLayer(id);
    if (layer.kind !== 'pixel') throw new Error(`Layer ${id} is not a pixel layer`);
    return layer;
  }

  /** All layers, depth first; each group is followed by its children, bottom → top. */
  *layers(parent: GroupLayer = this.root): IterableIterator<LayerNode> {
    for (const child of parent.children) {
      yield child;
      if (child.kind === 'group') yield* this.layers(child);
    }
  }

  get layerCount(): number {
    return this.#layersById.size;
  }

  get background(): PixelLayer | undefined {
    const bottom = this.root.children[0];
    return bottom?.kind === 'pixel' && bottom.isBackground ? bottom : undefined;
  }

  get activeLayerId(): string | null {
    return this.#activeLayerId;
  }

  get activeLayer(): LayerNode | undefined {
    return this.#activeLayerId ? this.getLayer(this.#activeLayerId) : undefined;
  }

  /** Selected layers, in the order they were selected. */
  get selectedLayerIds(): readonly string[] {
    return this.#selectedIds;
  }

  /** Where a layer sits: its parent and index (bottom → top). */
  positionOf(id: string): { parentId: string; index: number } {
    const layer = this.requireLayer(id);
    if (!layer.parent) throw new Error(`Layer ${id} has no parent`);
    return { parentId: layer.parent.id, index: layer.parent.children.indexOf(layer) };
  }

  /** True when `id` is `ancestorId` or inside it. */
  isWithin(id: string, ancestorId: string): boolean {
    let node: LayerNode | GroupLayer | null | undefined = this.getLayer(id);
    while (node) {
      if (node.id === ancestorId) return true;
      node = node.parent;
    }
    return false;
  }

  /** Bottom → top stacking order of all layers (depth first), as ids. */
  stackOrder(): string[] {
    return [...this.layers()].map((l) => l.id);
  }

  // ---------------------------------------------------------------------------
  // Primitives for commands
  // ---------------------------------------------------------------------------

  /** Inserts `layer` into `parent` at `index` (default: on top). */
  insertLayer(layer: LayerNode, parentId: string = this.root.id, index?: number): void {
    const parent = parentId === this.root.id ? this.root : this.requireLayer(parentId);
    if (parent.kind !== 'group') throw new Error(`Layer ${parentId} is not a group`);
    if (layer.parent || this.#layersById.has(layer.id)) throw new Error(`Layer ${layer.id} is already in a document`);
    const at = index ?? parent.children.length;
    if (!Number.isInteger(at) || at < 0 || at > parent.children.length) throw new Error(`Invalid layer index ${at}`);
    this.#checkPlacement(layer, parent, at);
    if (
      layer.kind === 'pixel' &&
      (layer.buffer.format.depth !== this.depth || layer.buffer.format.colorChannels !== this.colorChannels)
    ) {
      throw new Error(`Layer ${layer.id} pixel format does not match the document`);
    }

    assertResident(layer);
    parent.children.splice(at, 0, layer);
    layer.parent = parent;
    this.#register(layer);
    this.changes.emit({ kind: 'structure' });
  }

  /** Removes a layer (and its children); returns where it was, for undo. */
  removeLayer(id: string): { parentId: string; index: number; layer: LayerNode } {
    const layer = this.requireLayer(id);
    const parent = layer.parent;
    if (!parent) throw new Error(`Layer ${id} has no parent`);
    const index = parent.children.indexOf(layer);
    parent.children.splice(index, 1);
    layer.parent = null;
    this.#unregister(layer);
    this.changes.emit({ kind: 'structure' });
    const remaining = this.#selectedIds.filter((s) => this.#layersById.has(s));
    if (
      remaining.length !== this.#selectedIds.length ||
      (this.#activeLayerId && !this.#layersById.has(this.#activeLayerId))
    ) {
      this.selectLayers(remaining, remaining.at(-1) ?? null);
    }
    return { parentId: parent.id, index, layer };
  }

  /**
   * Moves a layer (with its children) to `index` in group `parentId`, where `index`
   * counts the target's children without the moving layer. Returns where it was.
   */
  moveLayer(id: string, parentId: string, index: number): { parentId: string; index: number } {
    const layer = this.requireLayer(id);
    if (layer.kind === 'pixel' && layer.isBackground) throw new Error('The Background layer cannot be moved');
    const target = parentId === this.root.id ? this.root : this.requireLayer(parentId);
    if (target.kind !== 'group') throw new Error(`Layer ${parentId} is not a group`);
    if (target !== this.root && this.isWithin(target.id, id)) throw new Error('A group cannot be moved into itself');
    const from = this.positionOf(id);
    const source = layer.parent!;
    source.children.splice(from.index, 1);
    const at = Math.max(0, Math.min(index, target.children.length));
    try {
      this.#checkPlacement(layer, target, at);
    } catch (error) {
      source.children.splice(from.index, 0, layer); // put it back
      throw error;
    }
    target.children.splice(at, 0, layer);
    layer.parent = target;
    this.changes.emit({ kind: 'structure' });
    return from;
  }

  /**
   * Changes layer properties and returns their previous values (for undo).
   * Enforces Background-layer and lock restrictions.
   */
  updateLayer<P extends Partial<PixelLayerProps & GroupLayerProps>>(id: string, props: P): P {
    const layer = this.requireLayer(id);
    const can = layerCapabilities(layer);
    const previous: Record<string, unknown> = {};
    const background = layer.kind === 'pixel' && layer.isBackground;
    const current = layer as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(props) as [keyof (PixelLayerProps & GroupLayerProps), unknown][]) {
      if ((key === 'opacity' || key === 'fillOpacity') && !can.changeOpacity && value !== current[key]) {
        throw new Error(background ? 'The Background layer is always fully opaque' : `"${layer.name}" is locked`);
      }
      if (key === 'blendMode' && !can.changeBlendMode && value !== current[key]) {
        throw new Error(
          background ? 'The Background layer always uses the Normal blend mode' : `"${layer.name}" is locked`,
        );
      }
      if (key === 'blendMode' && value === 'pass-through' && layer.kind === 'pixel') {
        throw new Error('Pass Through applies to groups only');
      }
      if ((key === 'offsetX' || key === 'offsetY') && layer.kind === 'pixel') {
        if (layer.isBackground && value !== 0) throw new Error('The Background layer cannot be moved');
        if (!Number.isInteger(value)) throw new Error('Layer offsets are whole pixels');
      }
      if ((key === 'opacity' || key === 'fillOpacity') && (typeof value !== 'number' || value < 0 || value > 1)) {
        throw new Error(`${key} must be between 0 and 1`);
      }
      if (!(key in layer)) throw new Error(`Layer ${id} has no property ${key}`);
      previous[key] = current[key];
    }
    Object.assign(layer, props);
    this.changes.emit({ kind: 'layer', layerId: id, props: Object.keys(props) });
    return previous as P;
  }

  /**
   * Changes canvas properties and returns their previous values (for undo). Colour
   * mode and bit depth can only change while the document has no layers: mode
   * conversions replace every layer with a converted one.
   */
  setCanvasProps(props: Partial<CanvasProps>): Partial<CanvasProps> {
    const formatChange =
      (props.mode !== undefined && props.mode !== this.mode) ||
      (props.depth !== undefined && props.depth !== this.depth) ||
      (props.multichannelCount !== undefined && props.multichannelCount !== this.multichannelCount);
    if (formatChange && this.layerCount > 0)
      throw new Error('Remove all layers before changing colour mode or bit depth');
    checkCanvasSize(props.width ?? this.width, props.height ?? this.height);
    if (props.resolution !== undefined && !(props.resolution > 0)) throw new Error('Resolution must be positive');
    const previous: Partial<CanvasProps> = {};
    for (const key of Object.keys(props) as (keyof CanvasProps)[]) {
      (previous as Record<string, unknown>)[key] = this[key];
    }
    Object.assign(this, props);
    this.changes.emit({ kind: 'canvas' });
    return previous;
  }

  /** Selects exactly one layer (or none), making it active. */
  setActiveLayer(id: string | null): void {
    this.selectLayers(id === null ? [] : [id], id);
  }

  /**
   * Sets the selected layers and the active one (which must be among them; by
   * default the last). Layer selection is not a history step, as in the reference app.
   */
  selectLayers(ids: readonly string[], activeId: string | null = ids.at(-1) ?? null): void {
    for (const id of ids) this.requireLayer(id);
    const unique = [...new Set(ids)];
    if (activeId !== null && !unique.includes(activeId)) throw new Error(`Active layer ${activeId} is not selected`);
    const same =
      activeId === this.#activeLayerId &&
      unique.length === this.#selectedIds.length &&
      unique.every((v, i) => v === this.#selectedIds[i]);
    if (same) return;
    this.#selectedIds = unique;
    this.#activeLayerId = activeId;
    this.changes.emit({ kind: 'active-layer', layerId: activeId });
  }

  // ---------------------------------------------------------------------------

  #checkPlacement(layer: LayerNode, parent: GroupLayer, index: number): void {
    const isBackground = layer.kind === 'pixel' && layer.isBackground;
    if (isBackground) {
      if (parent !== this.root || index !== 0) throw new Error('The Background layer must be the bottom layer');
      if (this.background) throw new Error('A document can only have one Background layer');
      if (layer.offsetX !== 0 || layer.offsetY !== 0) throw new Error('The Background layer cannot be offset');
    } else if (parent === this.root && index === 0 && this.background) {
      throw new Error('Nothing can be placed below the Background layer');
    }
  }

  #register(layer: LayerNode): void {
    this.#layersById.set(layer.id, layer);
    if (layer.kind === 'pixel') {
      layer.buffer.attach();
      const unsubscribe = layer.buffer.onTileChange((tx, ty) => {
        const rect = {
          x: tx * TILE_SIZE + layer.offsetX,
          y: ty * TILE_SIZE + layer.offsetY,
          w: TILE_SIZE,
          h: TILE_SIZE,
        };
        if (!isEmptyRect(rect)) this.changes.emit({ kind: 'pixels', layerId: layer.id, rect });
      });
      this.#unsubscribe.set(layer.id, unsubscribe);
    } else {
      for (const child of layer.children) {
        child.parent = layer;
        this.#register(child);
      }
    }
  }

  #unregister(layer: LayerNode): void {
    this.#layersById.delete(layer.id);
    if (layer.kind === 'pixel') layer.buffer.detach();
    this.#unsubscribe.get(layer.id)?.();
    this.#unsubscribe.delete(layer.id);
    if (layer.kind === 'group') for (const child of layer.children) this.#unregister(child);
  }
}
