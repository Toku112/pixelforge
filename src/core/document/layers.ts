/**
 * Layer tree nodes.
 *
 * Children are ordered bottom → top (index 0 is the bottom-most layer), matching
 * compositing order and the PSD file layout; the Layers panel shows them reversed.
 */
import type { TiledBuffer } from './tiled-buffer';

/** The 27 layer blend modes, plus Pass Through for groups. Formulas: docs/FORMAT_NOTES.md §3. */
export const LAYER_BLEND_MODES = [
  'normal',
  'dissolve',
  'darken',
  'multiply',
  'color-burn',
  'linear-burn',
  'darker-color',
  'lighten',
  'screen',
  'color-dodge',
  'linear-dodge',
  'lighter-color',
  'overlay',
  'soft-light',
  'hard-light',
  'vivid-light',
  'linear-light',
  'pin-light',
  'hard-mix',
  'difference',
  'exclusion',
  'subtract',
  'divide',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const;

export type LayerBlendMode = (typeof LAYER_BLEND_MODES)[number];
export type BlendMode = LayerBlendMode | 'pass-through';

export interface LayerLocks {
  /** Transparent pixels cannot be painted ("lock transparent pixels"). */
  readonly transparency: boolean;
  /** Pixels cannot be edited. */
  readonly pixels: boolean;
  /** The layer cannot be moved or transformed. */
  readonly position: boolean;
  /** Prevents automatic nesting into/out of artboards. */
  readonly artboardNesting: boolean;
  /** Everything above. */
  readonly all: boolean;
}

export const NO_LOCKS: LayerLocks = Object.freeze({
  transparency: false,
  pixels: false,
  position: false,
  artboardNesting: false,
  all: false,
});

/** Layer properties that commands may change through `ImageDocument.updateLayer`. */
export interface LayerProps {
  name: string;
  visible: boolean;
  /** 0–1. */
  opacity: number;
  /** 0–1 ("Fill" opacity: affects layer content but not layer effects). */
  fillOpacity: number;
  blendMode: BlendMode;
  locks: LayerLocks;
}

export interface PixelLayerProps extends LayerProps {
  /** Integer translation of the layer's pixel buffer in document space. */
  offsetX: number;
  offsetY: number;
}

export interface GroupLayerProps extends LayerProps {
  /** Whether the group is shown expanded in the Layers panel. */
  expanded: boolean;
}

abstract class LayerBase implements LayerProps {
  abstract readonly kind: 'pixel' | 'group';
  readonly id: string;
  name: string;
  visible = true;
  opacity = 1;
  fillOpacity = 1;
  blendMode: BlendMode = 'normal';
  locks: LayerLocks = NO_LOCKS;
  /** Set by the document when the layer is inserted into the tree. */
  parent: GroupLayer | null = null;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }
}

export class PixelLayer extends LayerBase implements PixelLayerProps {
  readonly kind = 'pixel' as const;
  readonly buffer: TiledBuffer;
  readonly isBackground: boolean;
  offsetX = 0;
  offsetY = 0;

  constructor(id: string, name: string, buffer: TiledBuffer, isBackground = false) {
    super(id, name);
    this.buffer = buffer;
    this.isBackground = isBackground;
    if (isBackground && buffer.format.hasAlpha) throw new Error('A Background layer has no transparency');
  }
}

export class GroupLayer extends LayerBase implements GroupLayerProps {
  readonly kind = 'group' as const;
  /** Bottom → top. */
  readonly children: LayerNode[] = [];
  expanded = true;

  constructor(id: string, name: string) {
    super(id, name);
    this.blendMode = 'pass-through';
  }
}

export type LayerNode = PixelLayer | GroupLayer;

/**
 * What may be done to a layer. The Background layer behaves like the reference app's:
 * always at the bottom, opaque, and its position, opacity, fill and blend mode are fixed.
 */
export interface LayerCapabilities {
  move: boolean;
  reorder: boolean;
  changeOpacity: boolean;
  changeBlendMode: boolean;
  editPixels: boolean;
}

export function layerCapabilities(layer: LayerNode): LayerCapabilities {
  const background = layer.kind === 'pixel' && layer.isBackground;
  return {
    move: !background && !layer.locks.position && !layer.locks.all,
    reorder: !background,
    changeOpacity: !background,
    changeBlendMode: !background,
    editPixels: layer.kind === 'pixel' && !layer.locks.pixels && !layer.locks.all,
  };
}
