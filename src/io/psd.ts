/**
 * Opening and saving PSD files (the pixel work runs in the codec worker, see
 * io/psd-format.ts): builds a document from the file's layer tree, and gathers a
 * document's layers for writing.
 */
import { planFromDocument } from '../core/composite/flatten';
import { ImageDocument } from '../core/document/document';
import { GroupLayer, PixelLayer, type LayerNode } from '../core/document/layers';
import { adoptTile, type TileMemory } from '../core/document/tile';
import { TiledBuffer } from '../core/document/tiled-buffer';
import type { CodecWorkerClient } from '../workers/codec-client';
import { formatById } from './formats';
import type { PsdNode, PsdSaveNode } from './psd-format';

export interface PsdOpenOptions {
  memory: TileMemory;
  shared: boolean;
}

export interface OpenedDocument {
  doc: ImageDocument;
  /** File features that were simplified on opening, in plain words (empty when none). */
  simplified: string[];
}

/** Opens a PSD (or PSB) file as a document. */
export async function openPsd(
  bytes: Uint8Array,
  fileName: string,
  codec: CodecWorkerClient,
  options: PsdOpenOptions,
): Promise<OpenedDocument> {
  const file = await codec.readPsd(bytes, { shared: options.shared });
  const doc = new ImageDocument({
    width: file.width,
    height: file.height,
    name: fileName,
    mode: file.mode,
    depth: file.depth,
    resolution: Math.round(file.resolution * 1000) / 1000,
    memory: options.memory,
  });
  const build = (node: PsdNode): LayerNode => {
    let layer: LayerNode;
    if (node.kind === 'group') {
      const group = doc.createGroup(node.name);
      group.blendMode = node.blendMode;
      group.expanded = node.expanded;
      for (const child of node.children) {
        const c = build(child);
        c.parent = group;
        group.children.push(c);
      }
      layer = group;
    } else {
      const format = doc.layerFormat(!node.isBackground);
      const buffer = new TiledBuffer(format, {
        memory: options.memory,
        defaultPixel: node.isBackground ? doc.whitePixel() : undefined,
      });
      for (const t of node.tiles) buffer.setTile(t.tx, t.ty, adoptTile(t.data, format, options.memory));
      const pixel = new PixelLayer(
        doc.newLayerId(),
        node.isBackground ? 'Background' : node.name,
        buffer,
        node.isBackground,
      );
      pixel.offsetX = node.offsetX;
      pixel.offsetY = node.offsetY;
      pixel.blendMode = node.blendMode;
      layer = pixel;
    }
    layer.visible = node.visible;
    layer.opacity = node.opacity;
    layer.fillOpacity = node.fillOpacity;
    if (!(layer instanceof PixelLayer && layer.isBackground)) layer.locks = { ...layer.locks, ...node.locks };
    return layer;
  };
  for (const node of file.layers) doc.insertLayer(build(node));
  const top = doc.root.children.at(-1);
  doc.setActiveLayer(top?.id ?? null);
  return { doc, simplified: file.simplified };
}

/** The document's layer tree for writing (tile data is passed to the worker, not copied here). */
function saveNodes(nodes: readonly LayerNode[]): PsdSaveNode[] {
  return nodes.map((n): PsdSaveNode => {
    const common = {
      name: n.name,
      visible: n.visible,
      opacity: n.opacity,
      fillOpacity: n.fillOpacity,
      locks: {
        transparency: n.locks.transparency || n.locks.all,
        pixels: n.locks.pixels || n.locks.all,
        position: n.locks.position || n.locks.all,
      },
    };
    if (n instanceof GroupLayer)
      return {
        ...common,
        kind: 'group',
        blendMode: n.blendMode,
        expanded: n.expanded,
        children: saveNodes(n.children),
      };
    const pixel = n;
    return {
      ...common,
      kind: 'pixel',
      blendMode: pixel.blendMode === 'pass-through' ? 'normal' : pixel.blendMode,
      isBackground: pixel.isBackground,
      offsetX: pixel.offsetX,
      offsetY: pixel.offsetY,
      format: pixel.buffer.format,
      defaultPixel: pixel.buffer.defaultPixel,
      tiles: [...pixel.buffer.tiles()].map(([tx, ty, t]) => ({ tx, ty, data: t.data })),
    };
  });
}

/** Encodes a document as an 8-bit RGB PSD with its layers. */
export async function encodeDocumentAsPsd(doc: ImageDocument, codec: CodecWorkerClient): Promise<Uint8Array> {
  const restriction = formatById('psd').saveRestriction(doc);
  if (restriction) throw new Error(restriction);
  return codec.writePsd(
    { width: doc.width, height: doc.height, resolution: doc.resolution, layers: saveNodes(doc.root.children) },
    planFromDocument(doc),
  );
}
