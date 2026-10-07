/**
 * Image Size, Canvas Size, Crop and Image Rotation: changes to the whole document.
 *
 * Behaviour (own summary of the reference app):
 * - Canvas Size adds or removes canvas around the image from an anchor; the new
 *   area of the Background gets the canvas extension colour, other layers simply
 *   keep their pixels (also outside the canvas).
 * - Crop (Image > Crop, the Crop tool) makes a rectangle the new canvas; with
 *   Delete Cropped Pixels, pixels outside it are discarded from every layer.
 * - Image Rotation turns or flips the whole image, every layer with it.
 * - Image Size resamples every layer (or only changes the resolution).
 * Rotation and Image Size deselect; Canvas Size and Crop move the selection with
 * the image.
 *
 * Each is one History step: the document before and after are snapshots sharing
 * unchanged tiles, and the pixel work runs in the worker, layer by layer.
 */
import type { ImageDocument } from '../../document/document';
import type { Rect } from '../../document/geometry';
import { GroupLayer, PixelLayer, type LayerNode } from '../../document/layers';
import { adoptTile, type Tile } from '../../document/tile';
import { TiledBuffer } from '../../document/tiled-buffer';
import type { CanvasProps } from '../../document/document';
import type { LayerSource, PixelMap, ResampleMethod } from '../../geometry/layer-geometry';
import {
  captureDocumentState,
  copyLayerProps,
  restoreDocumentState,
  stateTiles,
  type DocumentState,
} from '../../history/snapshot';
import type { Selection } from '../../selection/selection';
import {
  CommandCancelledError,
  CommandUnavailableError,
  type Command,
  type CommandContext,
  type JsonObject,
} from '../command';
import type { CommandDefinition } from '../registry';
import { backgroundToLayerBuffer } from './layer-common';

/** What happens to one pixel layer. */
export type LayerGeometry =
  | { kind: 'offset'; dx: number; dy: number }
  | { kind: 'map'; map: PixelMap; clip: Rect | null }
  | { kind: 'resample'; scaleX: number; scaleY: number; method: ResampleMethod; clip: Rect | null };

interface Plan {
  canvas: Partial<CanvasProps>;
  layer: (layer: PixelLayer) => LayerGeometry;
  selection: Selection | null;
  /** Turn the Background into a normal layer first (Crop keeping cropped pixels). */
  convertBackground?: boolean;
}

interface LayerResult {
  buffer: TiledBuffer;
  offsetX: number;
  offsetY: number;
  /** The Background became a normal layer with this name. */
  rename?: string;
}

function pixelLayers(nodes: readonly LayerNode[]): PixelLayer[] {
  return nodes.flatMap((n) => (n.kind === 'pixel' ? [n] : pixelLayers(n.children)));
}

/** The worker's view of a layer. */
export function layerSource(doc: ImageDocument, layer: PixelLayer): LayerSource {
  return {
    format: layer.buffer.format,
    defaultPixel: layer.buffer.defaultPixel,
    offsetX: layer.offsetX,
    offsetY: layer.offsetY,
    tiles: [...layer.buffer.tiles()].map(([tx, ty, t]) => ({ tx, ty, data: t.data })),
    domain: layer.isBackground ? doc.canvasRect : null,
  };
}

class GeometryCommand implements Command {
  readonly label: string;
  readonly descriptor: { name: string; params: JsonObject };
  readonly undoBytes = 0;
  readonly #ctx: CommandContext;
  readonly #plan: (doc: ImageDocument) => Plan | Promise<Plan>;
  readonly #fill: readonly number[] | undefined;
  #before: DocumentState | null = null;
  #after: DocumentState | null = null;

  constructor(
    ctx: CommandContext,
    label: string,
    descriptor: { name: string; params: JsonObject },
    plan: (doc: ImageDocument) => Plan | Promise<Plan>,
    fill: readonly number[] | undefined,
  ) {
    this.#ctx = ctx;
    this.label = label;
    this.descriptor = descriptor;
    this.#plan = plan;
    this.#fill = fill;
  }

  retainedTiles(): Iterable<Tile> {
    return [...(this.#before ? stateTiles(this.#before) : []), ...(this.#after ? stateTiles(this.#after) : [])];
  }

  async execute(): Promise<void> {
    const { doc, services, task } = this.#ctx;
    const plan = await this.#plan(doc);
    const fill = [...(this.#fill ?? doc.whitePixel())];
    const layers = pixelLayers(doc.root.children);
    const results = new Map<string, LayerResult>();
    for (const [i, layer] of layers.entries()) {
      if (task?.cancelled) throw new CommandCancelledError();
      const geometry = plan.layer(layer);
      if (layer.isBackground && plan.convertBackground) {
        if (geometry.kind !== 'offset') throw new Error('Only an offset can follow converting the Background');
        results.set(layer.id, {
          buffer: await backgroundToLayerBuffer(doc, layer, services),
          offsetX: layer.offsetX + geometry.dx,
          offsetY: layer.offsetY + geometry.dy,
          rename: 'Layer 0',
        });
      } else if (geometry.kind === 'offset') {
        results.set(layer.id, {
          buffer: layer.buffer.clone(),
          offsetX: layer.offsetX + geometry.dx,
          offsetY: layer.offsetY + geometry.dy,
        });
      } else {
        const format = layer.buffer.format;
        const background = format.hasAlpha ? null : fill;
        const tiles = await services.pixelOps.transformLayer(layerSource(doc, layer), geometry, background);
        const buffer = new TiledBuffer(format, { memory: doc.memory, defaultPixel: background ?? undefined });
        for (const t of tiles) buffer.setTile(t.tx, t.ty, adoptTile(t.data, format, doc.memory));
        results.set(layer.id, { buffer, offsetX: 0, offsetY: 0 });
      }
      task?.progress((i + 1) / layers.length);
    }
    if (task?.cancelled) throw new CommandCancelledError();
    this.#before = captureDocumentState(doc);
    const rebuild = (node: LayerNode): LayerNode => {
      let copy: LayerNode;
      if (node.kind === 'pixel') {
        const r = results.get(node.id)!;
        const pixel = new PixelLayer(node.id, r.rename ?? node.name, r.buffer, node.isBackground && !r.rename);
        pixel.offsetX = r.offsetX;
        pixel.offsetY = r.offsetY;
        copy = pixel;
      } else {
        const group = new GroupLayer(node.id, node.name);
        group.expanded = node.expanded;
        for (const child of node.children) {
          const c = rebuild(child);
          c.parent = group;
          group.children.push(c);
        }
        copy = group;
      }
      copyLayerProps(node, copy);
      return copy;
    };
    this.#after = {
      ...this.#before,
      canvas: { ...this.#before.canvas, ...plan.canvas },
      layers: doc.root.children.map(rebuild),
      selection: plan.selection,
      // Deselecting keeps the outline for Select > Reselect, like Deselect does.
      reselect: plan.selection === null && this.#before.selection ? this.#before.selection : this.#before.reselect,
    };
    restoreDocumentState(doc, this.#after);
  }

  undo(): void {
    restoreDocumentState(this.#ctx.doc, this.#before!);
  }

  redo(): void {
    restoreDocumentState(this.#ctx.doc, this.#after!);
  }
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseColor(p: JsonObject): number[] | undefined {
  const c = p['color'];
  if (c === undefined) return undefined;
  if (!Array.isArray(c) || !c.every(isNum)) throw new Error('color must be a list of numbers');
  return c;
}

function size(p: JsonObject, name: string): number {
  const v = p[name];
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 300000)
    throw new Error(`${name} must be 1–300000 px`);
  return v as number;
}

const RESAMPLE_METHODS: readonly ResampleMethod[] = [
  'nearest',
  'bilinear',
  'bicubic',
  'bicubic-smoother',
  'bicubic-sharper',
  'automatic',
];

/** Anchor fraction (0 = left/top, 0.5 = centre, 1 = right/bottom). */
function anchor(v: unknown): number {
  if (v !== 0 && v !== 0.5 && v !== 1) throw new Error('anchor values must be 0, 0.5 or 1');
  return v;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const geometryCommands: CommandDefinition[] = [
  {
    name: 'canvasSize',
    create: (ctx, p) => {
      const width = size(p, 'width');
      const height = size(p, 'height');
      const ax = anchor((p['anchor'] as number[] | undefined)?.[0] ?? 0.5);
      const ay = anchor((p['anchor'] as number[] | undefined)?.[1] ?? 0.5);
      return new GeometryCommand(
        ctx,
        'Canvas Size',
        { name: 'canvasSize', params: p },
        (doc) => {
          const dx = Math.round((width - doc.width) * ax);
          const dy = Math.round((height - doc.height) * ay);
          const canvas = { x: 0, y: 0, w: width, h: height };
          return {
            canvas: { width, height },
            layer: (l) =>
              l.isBackground
                ? { kind: 'map', map: { kind: 'shift', dx, dy }, clip: canvas }
                : { kind: 'offset', dx, dy },
            selection: doc.selection?.moved(dx, dy) ?? null,
          };
        },
        parseColor(p),
      );
    },
  },
  {
    // Without a rectangle: Image > Crop, to the bounds of the selection.
    name: 'crop',
    create: (ctx, p) => {
      const toSelection = p['x'] === undefined && p['y'] === undefined && p['w'] === undefined && p['h'] === undefined;
      let given: Rect | null = null;
      if (!toSelection) {
        const { x, y } = p;
        if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('crop: x and y must be whole pixels');
        given = { x: x as number, y: y as number, w: size(p, 'w'), h: size(p, 'h') };
      }
      const deleteCropped = p['deleteCropped'] !== false;
      return new GeometryCommand(
        ctx,
        'Crop',
        { name: 'crop', params: p },
        async (doc) => {
          let r = given;
          if (!r) {
            if (!doc.selection) throw new CommandUnavailableError('Image > Crop needs a selection');
            r = await ctx.services.pixelOps.maskBounds(doc.selection.data, doc.canvasRect);
            if (!r) throw new CommandUnavailableError('No pixels are selected');
          }
          const { w, h } = r;
          const dx = -r.x;
          const dy = -r.y;
          const canvas = { x: 0, y: 0, w, h };
          return {
            canvas: { width: w, height: h },
            layer: () =>
              deleteCropped
                ? { kind: 'map', map: { kind: 'shift', dx, dy }, clip: canvas }
                : { kind: 'offset', dx, dy },
            selection: doc.selection?.moved(dx, dy) ?? null,
            convertBackground: !deleteCropped,
          };
        },
        parseColor(p),
      );
    },
  },
  {
    name: 'rotateCanvas',
    create: (ctx, p) => {
      const turns = p['turns'];
      const flip = p['flip'];
      if (turns !== undefined && turns !== 1 && turns !== 2 && turns !== 3)
        throw new Error('rotateCanvas: turns must be 1, 2 or 3');
      if (flip !== undefined && flip !== 'horizontal' && flip !== 'vertical')
        throw new Error('rotateCanvas: flip must be horizontal or vertical');
      if ((turns === undefined) === (flip === undefined)) throw new Error('rotateCanvas: give either turns or flip');
      const label =
        flip === 'horizontal'
          ? 'Flip Canvas Horizontal'
          : flip === 'vertical'
            ? 'Flip Canvas Vertical'
            : 'Rotate Canvas';
      return new GeometryCommand(
        ctx,
        label,
        { name: 'rotateCanvas', params: p },
        (doc) => {
          const quarter = turns === 1 || turns === 3;
          const width = quarter ? doc.height : doc.width;
          const height = quarter ? doc.width : doc.height;
          const map: PixelMap = flip
            ? { kind: 'flip', axis: flip, width: doc.width, height: doc.height }
            : { kind: 'rotate', turns: turns as 1 | 2 | 3, width: doc.width, height: doc.height };
          return {
            canvas: { width, height },
            layer: (l) => ({ kind: 'map', map, clip: l.isBackground ? { x: 0, y: 0, w: width, h: height } : null }),
            selection: null,
          };
        },
        undefined,
      );
    },
  },
  {
    name: 'imageSize',
    create: (ctx, p) => {
      const width = size(p, 'width');
      const height = size(p, 'height');
      const resolution = p['resolution'];
      if (resolution !== undefined && (!isNum(resolution) || resolution <= 0))
        throw new Error('imageSize: resolution must be positive');
      const method = p['method'] ?? 'automatic';
      if (!RESAMPLE_METHODS.includes(method as ResampleMethod)) throw new Error('imageSize: unknown resampling method');
      return new GeometryCommand(
        ctx,
        'Image Size',
        { name: 'imageSize', params: p },
        (doc) => {
          const same = width === doc.width && height === doc.height;
          const canvas = { x: 0, y: 0, w: width, h: height };
          return {
            canvas: { width, height, ...(resolution !== undefined ? { resolution } : {}) },
            layer: (l) =>
              same
                ? { kind: 'offset', dx: 0, dy: 0 }
                : {
                    kind: 'resample',
                    scaleX: width / doc.width,
                    scaleY: height / doc.height,
                    method: method as ResampleMethod,
                    clip: l.isBackground ? canvas : null,
                  },
            selection: same ? doc.selection : null,
          };
        },
        undefined,
      );
    },
  },
];
