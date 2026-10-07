/**
 * PSD files ⇄ document data, through ag-psd (runs in the codec worker).
 *
 * Kept on opening: canvas size, resolution, bit depth (8/16/32), RGB or Grayscale,
 * the layer tree with names, visibility, opacity, fill, blend modes, group
 * expansion, locks, and the Background layer. Features this version cannot hold
 * yet (masks, clipping, layer styles, text and smart-object editability, adjustment
 * layers) are simplified and listed, so the app can tell the user (FORMAT_NOTES §5.3).
 *
 * Saving writes 8-bit RGB with the same layer properties and a flattened composite
 * (what other apps show when they do not read layers).
 */
import {
  initializeCanvas,
  readPsd,
  writePsdUint8Array,
  type BlendMode as PsdBlendMode,
  type Layer,
  type Psd,
} from 'ag-psd';
import { LAYER_BLEND_MODES, type BlendMode, type LayerBlendMode } from '../core/document/layers';
import type { PixelFormat, SampleArray } from '../core/document/pixel-format';
import { TILE_PIXELS, TILE_SIZE } from '../core/document/tile';
import { contentBounds } from '../core/geometry/layer-geometry';

export interface PsdLocks {
  transparency: boolean;
  pixels: boolean;
  position: boolean;
}

interface CommonProps {
  name: string;
  visible: boolean;
  opacity: number;
  fillOpacity: number;
  locks: PsdLocks;
}

export interface PsdPixelNode extends CommonProps {
  kind: 'pixel';
  blendMode: LayerBlendMode;
  isBackground: boolean;
  /** The layer's position: its tile (0, 0) starts here. */
  offsetX: number;
  offsetY: number;
  /** Tiles with alpha (or without, for the Background); fully transparent ones are left out. */
  tiles: { tx: number; ty: number; data: SampleArray }[];
}

export interface PsdGroupNode extends CommonProps {
  kind: 'group';
  blendMode: BlendMode;
  expanded: boolean;
  /** Bottom → top. */
  children: PsdNode[];
}

export type PsdNode = PsdPixelNode | PsdGroupNode;

export interface PsdFileData {
  width: number;
  height: number;
  depth: 8 | 16 | 32;
  mode: 'rgb' | 'grayscale';
  resolution: number;
  /** Bottom → top. */
  layers: PsdNode[];
  /** Features of the file that were simplified on opening, in plain words. */
  simplified: string[];
}

// Pixels stay plain arrays (no canvas: it would premultiply alpha, and workers and tests have none).
initializeCanvas(
  () => {
    throw new Error('PSD reading and writing does not use a canvas');
  },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as unknown as ImageData,
);

/** Our blend mode ids are the PSD names with hyphens. */
const toOurs = (mode: PsdBlendMode | undefined): BlendMode | null => {
  if (!mode) return 'normal';
  if (mode === 'pass through') return 'pass-through';
  const id = mode.replace(/ /g, '-');
  return (LAYER_BLEND_MODES as readonly string[]).includes(id) ? (id as LayerBlendMode) : null;
};
const toPsd = (mode: BlendMode): PsdBlendMode => mode.replace(/-/g, ' ') as PsdBlendMode;

/** The reference app's 16-bit samples run 0–32768; ours 0–65535 (CLAUDE.md §3.3). */
const from16 = (v: number) => (v >= 32768 ? 65535 : Math.round((v * 65535) / 32768));
const to16 = (v: number) => Math.round((v * 32768) / 65535);

export class UnsupportedPsdError extends Error {
  override readonly name = 'UnsupportedPsdError';
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface PixelData {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array;
}

/** Cuts RGBA pixel data at (left, top) into tiles of the document's format. */
function toTiles(
  img: PixelData,
  format: PixelFormat,
  shared: boolean,
): { tx: number; ty: number; data: SampleArray }[] {
  const spp = format.colorChannels + (format.hasAlpha ? 1 : 0);
  const gray = format.colorChannels === 1;
  const bytes = format.depth === 8 ? 1 : format.depth === 16 ? 2 : 4;
  const conv = format.depth === 16 ? from16 : (v: number) => v;
  const tiles: { tx: number; ty: number; data: SampleArray }[] = [];
  for (let ty = 0; ty * TILE_SIZE < img.height; ty++) {
    for (let tx = 0; tx * TILE_SIZE < img.width; tx++) {
      const x0 = tx * TILE_SIZE;
      const y0 = ty * TILE_SIZE;
      const w = Math.min(TILE_SIZE, img.width - x0);
      const h = Math.min(TILE_SIZE, img.height - y0);
      const buffer = shared
        ? new SharedArrayBuffer(TILE_PIXELS * spp * bytes)
        : new ArrayBuffer(TILE_PIXELS * spp * bytes);
      const data =
        format.depth === 8
          ? new Uint8Array(buffer)
          : format.depth === 16
            ? new Uint16Array(buffer)
            : new Float32Array(buffer);
      let empty = format.hasAlpha;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const s = ((y0 + y) * img.width + x0 + x) * 4;
          const o = (y * TILE_SIZE + x) * spp;
          if (gray) data[o] = conv(img.data[s]!);
          else {
            data[o] = conv(img.data[s]!);
            data[o + 1] = conv(img.data[s + 1]!);
            data[o + 2] = conv(img.data[s + 2]!);
          }
          if (format.hasAlpha) {
            const a = conv(img.data[s + 3]!);
            data[o + format.colorChannels] = a;
            if (a !== 0) empty = false;
          }
        }
      }
      if (!format.hasAlpha && (w < TILE_SIZE || h < TILE_SIZE)) {
        // The Background's tiles past the canvas edge: white (they never show).
        const white = format.depth === 32 ? 1 : format.depth === 16 ? 65535 : 255;
        for (let y = 0; y < TILE_SIZE; y++)
          for (let x = 0; x < TILE_SIZE; x++)
            if (x >= w || y >= h) for (let c = 0; c < spp; c++) data[(y * TILE_SIZE + x) * spp + c] = white;
      }
      if (!empty) tiles.push({ tx, ty, data });
    }
  }
  return tiles;
}

function isOpaque(img: PixelData, depth: 8 | 16 | 32): boolean {
  const full = depth === 8 ? 255 : depth === 16 ? 0xffff : 1;
  for (let i = 3; i < img.data.length; i += 4) {
    if (depth === 16 ? img.data[i]! < 32768 : img.data[i] !== full) return false;
  }
  return true;
}

/** Reads a PSD (or PSB) file. */
export function readPsdFile(bytes: Uint8Array, shared: boolean): PsdFileData {
  const options = { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true } as const;
  const psd: Psd = readPsd(bytes, { ...options, skipCompositeImageData: true });
  const colorMode: number = psd.colorMode ?? 3;
  if (colorMode !== 3 && colorMode !== 1) {
    const names: Record<number, string> = {
      0: 'Bitmap',
      2: 'Indexed Color',
      4: 'CMYK',
      7: 'Multichannel',
      8: 'Duotone',
      9: 'Lab',
    };
    throw new UnsupportedPsdError(
      `${names[colorMode] ?? 'This colour mode'} PSD files cannot be opened yet (they arrive with colour management).`,
    );
  }
  const bits = psd.bitsPerChannel ?? 8;
  if (bits !== 8 && bits !== 16 && bits !== 32) throw new UnsupportedPsdError('1-bit PSD files cannot be opened yet.');
  const depth = bits;
  const gray = colorMode === 1;
  const colorChannels = gray ? 1 : 3;
  const simplified = new Set<string>();
  const res = psd.imageResources?.resolutionInfo;
  const resolution = res
    ? res.horizontalResolutionUnit === 'PPCM'
      ? res.horizontalResolution * 2.54
      : res.horizontalResolution
    : 72;

  const locksOf = (l: Layer): PsdLocks => ({
    transparency: !!l.protected?.transparency,
    pixels: !!l.protected?.composite,
    position: !!l.protected?.position,
  });

  const convert = (layers: Layer[], atRoot: boolean): PsdNode[] => {
    const out: PsdNode[] = [];
    layers.forEach((l, index) => {
      if (l.adjustment) {
        simplified.add('adjustment and fill layers were left out');
        return;
      }
      if (l.text) simplified.add('text layers opened as pixels');
      if (l.placedLayer) simplified.add('smart objects opened as pixels');
      if (l.mask || l.realMask || l.vectorMask) simplified.add('layer and vector masks were ignored');
      if (l.clipping) simplified.add('clipping masks were ignored');
      if (l.effects && !l.effects.disabled) simplified.add('layer styles were ignored');
      let blendMode = toOurs(l.blendMode);
      if (!blendMode) {
        simplified.add('some blend modes became Normal');
        blendMode = 'normal';
      }
      const common: CommonProps = {
        name: l.name ?? '',
        visible: !l.hidden,
        opacity: l.opacity ?? 1,
        fillOpacity: l.fillOpacity ?? 1,
        locks: locksOf(l),
      };
      if (l.children) {
        out.push({ ...common, kind: 'group', blendMode, expanded: !!l.opened, children: convert(l.children, false) });
        return;
      }
      const left = l.left ?? 0;
      const top = l.top ?? 0;
      const img = l.imageData;
      const width = img?.width ?? 0;
      const height = img?.height ?? 0;
      // The Background: the bottom layer of the file, covering the canvas, fully opaque,
      // with locked transparency (as the reference app writes it) or named so.
      const isBackground =
        atRoot &&
        index === 0 &&
        !!img &&
        left === 0 &&
        top === 0 &&
        width === psd.width &&
        height === psd.height &&
        (!!l.transparencyProtected || l.name === 'Background') &&
        isOpaque(img, depth);
      const format: PixelFormat = { depth, colorChannels, hasAlpha: !isBackground };
      out.push({
        ...common,
        kind: 'pixel',
        blendMode: blendMode === 'pass-through' ? 'normal' : blendMode,
        isBackground,
        offsetX: left,
        offsetY: top,
        tiles: img && width > 0 && height > 0 ? toTiles(img, format, shared) : [],
      });
    });
    return out;
  };

  let layers = convert(psd.children ?? [], true);
  // Files without layers (ag-psd writes one empty, unnamed placeholder for them).
  const only = layers.length === 1 ? layers[0] : undefined;
  if (layers.length === 0 || (only?.kind === 'pixel' && only.tiles.length === 0 && only.name === '')) {
    // A file without layers: its composite becomes the Background (or Layer 0 with transparency).
    const flat = readPsd(bytes, { ...options, skipLayerImageData: true });
    const img = flat.imageData;
    if (img) {
      const opaque = isOpaque(img, depth);
      layers = [
        {
          kind: 'pixel',
          name: opaque ? 'Background' : 'Layer 0',
          visible: true,
          opacity: 1,
          fillOpacity: 1,
          locks: { transparency: false, pixels: false, position: false },
          blendMode: 'normal',
          isBackground: opaque,
          offsetX: 0,
          offsetY: 0,
          tiles: toTiles(img, { depth, colorChannels, hasAlpha: !opaque }, shared),
        },
      ];
    }
  }
  return {
    width: psd.width,
    height: psd.height,
    depth,
    mode: gray ? 'grayscale' : 'rgb',
    resolution,
    layers,
    simplified: [...simplified],
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface PsdSavePixel extends CommonProps {
  kind: 'pixel';
  blendMode: LayerBlendMode;
  isBackground: boolean;
  offsetX: number;
  offsetY: number;
  format: PixelFormat;
  defaultPixel: readonly number[];
  tiles: { tx: number; ty: number; data: SampleArray }[];
}

export interface PsdSaveGroup extends CommonProps {
  kind: 'group';
  blendMode: BlendMode;
  expanded: boolean;
  children: PsdSaveNode[];
}

export type PsdSaveNode = PsdSavePixel | PsdSaveGroup;

export interface PsdSaveData {
  width: number;
  height: number;
  resolution: number;
  /** Bottom → top. */
  layers: PsdSaveNode[];
}

/** A layer's visible area as straight RGBA, 8-bit (or nothing when it has no pixels). */
function layerImage(layer: PsdSavePixel, canvas: { w: number; h: number }) {
  const domain = layer.isBackground ? { x: 0, y: 0, w: canvas.w, h: canvas.h } : null;
  const source = { ...layer, domain };
  const area = contentBounds(source);
  if (!area || area.w === 0 || area.h === 0) return null;
  const { format } = layer;
  const spp = format.colorChannels + (format.hasAlpha ? 1 : 0);
  const data = new Uint8ClampedArray(area.w * area.h * 4);
  const tiles = new Map<string, SampleArray>();
  for (const t of layer.tiles) tiles.set(`${t.tx},${t.ty}`, t.data);
  for (let y = 0; y < area.h; y++) {
    for (let x = 0; x < area.w; x++) {
      const lx = area.x + x - layer.offsetX;
      const ly = area.y + y - layer.offsetY;
      const tx = Math.floor(lx / TILE_SIZE);
      const ty = Math.floor(ly / TILE_SIZE);
      const tile = tiles.get(`${tx},${ty}`);
      const i = ((ly - ty * TILE_SIZE) * TILE_SIZE + (lx - tx * TILE_SIZE)) * spp;
      const px = (c: number) => (tile ? tile[i + c]! : layer.defaultPixel[c]!);
      const o = (y * area.w + x) * 4;
      const gray = format.colorChannels === 1;
      data[o] = px(0);
      data[o + 1] = gray ? px(0) : px(1);
      data[o + 2] = gray ? px(0) : px(2);
      data[o + 3] = format.hasAlpha ? px(format.colorChannels) : 255;
    }
  }
  return { area, image: { width: area.w, height: area.h, data } };
}

/** Writes an 8-bit RGB PSD; `composite` is the flattened image (straight RGBA, 8-bit). */
export function writePsdFile(
  data: PsdSaveData,
  composite: { width: number; height: number; data: Uint8ClampedArray },
): Uint8Array {
  const canvas = { w: data.width, h: data.height };
  const protect = (locks: PsdLocks) => ({
    transparency: locks.transparency,
    composite: locks.pixels,
    position: locks.position,
  });
  const convert = (nodes: PsdSaveNode[]): Layer[] =>
    nodes.map((n) => {
      const common: Layer = {
        name: n.name,
        hidden: !n.visible,
        opacity: n.opacity,
        fillOpacity: n.fillOpacity,
        blendMode: toPsd(n.blendMode),
        protected: protect(n.locks),
      };
      if (n.kind === 'group') return { ...common, opened: n.expanded, children: convert(n.children) };
      const content = layerImage(n, canvas);
      if (n.isBackground) common.transparencyProtected = true;
      if (!content) return { ...common, top: 0, left: 0, bottom: 0, right: 0 };
      const { area, image } = content;
      return {
        ...common,
        top: area.y,
        left: area.x,
        bottom: area.y + area.h,
        right: area.x + area.w,
        imageData: image,
      };
    });
  const hasBackground = data.layers[0]?.kind === 'pixel' && data.layers[0].isBackground;
  const psd: Psd = {
    width: data.width,
    height: data.height,
    channels: 3,
    bitsPerChannel: 8,
    colorMode: 3,
    children: convert(data.layers),
    imageData: composite,
    imageResources: {
      resolutionInfo: {
        horizontalResolution: data.resolution,
        horizontalResolutionUnit: 'PPI',
        widthUnit: 'Inches',
        verticalResolution: data.resolution,
        verticalResolutionUnit: 'PPI',
        heightUnit: 'Inches',
      },
    },
  };
  return writePsdUint8Array(psd, { generateThumbnail: false, noBackground: !hasBackground });
}

/** The reference app's 16-bit scale, for tests and future 16-bit saving. */
export const psd16 = { from16, to16 };
