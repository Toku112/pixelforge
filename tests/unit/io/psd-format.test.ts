import { readPsd, writePsdUint8Array } from 'ag-psd';
import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '../../../src/core/document/tile';
import {
  psd16,
  readPsdFile,
  writePsdFile,
  type PsdGroupNode,
  type PsdPixelNode,
  type PsdSaveData,
} from '../../../src/io/psd-format';

const W = 300;
const H = 200;
const rgb = { depth: 8 as const, colorChannels: 3, hasAlpha: false };
const rgba = { depth: 8 as const, colorChannels: 3, hasAlpha: true };
const locks = { transparency: false, pixels: false, position: false };

/** A tile filled by `fn(x, y)` (tile-local) with `spp` samples per pixel. */
function tile(tx: number, ty: number, spp: number, fn: (x: number, y: number) => number[]) {
  const data = new Uint8Array(TILE_SIZE * TILE_SIZE * spp);
  for (let y = 0; y < TILE_SIZE; y++) for (let x = 0; x < TILE_SIZE; x++) data.set(fn(x, y), (y * TILE_SIZE + x) * spp);
  return { tx, ty, data };
}

function document(): PsdSaveData {
  const background = {
    kind: 'pixel' as const,
    name: 'Background',
    visible: true,
    opacity: 1,
    fillOpacity: 1,
    locks,
    blendMode: 'normal' as const,
    isBackground: true,
    offsetX: 0,
    offsetY: 0,
    format: rgb,
    defaultPixel: [255, 255, 255],
    tiles: [tile(0, 0, 3, (x, y) => [x, y, 7]), tile(1, 0, 3, () => [10, 20, 30])],
  };
  const red = {
    kind: 'pixel' as const,
    name: 'Red square',
    visible: false,
    opacity: 0.5,
    fillOpacity: 0.25,
    locks: { transparency: true, pixels: false, position: true },
    blendMode: 'multiply' as const,
    isBackground: false,
    offsetX: 40,
    offsetY: 30,
    format: rgba,
    defaultPixel: [0, 0, 0, 0],
    tiles: [tile(0, 0, 4, (x, y) => (x < 10 && y < 5 ? [255, 0, 0, 200] : [0, 0, 0, 0]))],
  };
  return {
    width: W,
    height: H,
    resolution: 300,
    layers: [
      background,
      {
        kind: 'group',
        name: 'Group 1',
        visible: true,
        opacity: 0.8,
        fillOpacity: 1,
        locks,
        blendMode: 'pass-through',
        expanded: true,
        children: [red],
      },
    ],
  };
}

const composite = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(128) };

const pixelAt = (node: PsdPixelNode, x: number, y: number) => {
  const lx = x - node.offsetX;
  const ly = y - node.offsetY;
  const t = node.tiles.find((t) => t.tx === Math.floor(lx / TILE_SIZE) && t.ty === Math.floor(ly / TILE_SIZE));
  if (!t) return null;
  const spp = node.isBackground ? 3 : 4;
  const i = ((ly % TILE_SIZE) * TILE_SIZE + (lx % TILE_SIZE)) * spp;
  return [...t.data.slice(i, i + spp)];
};

describe('PSD files', () => {
  it('round-trips layers, groups, properties, the Background and resolution', () => {
    const bytes = writePsdFile(document(), composite);
    expect([...bytes.slice(0, 4)].map((b) => String.fromCharCode(b)).join('')).toBe('8BPS');
    const file = readPsdFile(bytes, false);
    expect(file).toMatchObject({ width: W, height: H, depth: 8, mode: 'rgb', simplified: [] });
    expect(file.resolution).toBeCloseTo(300);
    const [bg, group] = file.layers as [PsdPixelNode, PsdGroupNode];
    expect(bg).toMatchObject({ kind: 'pixel', name: 'Background', isBackground: true, offsetX: 0, offsetY: 0 });
    expect(pixelAt(bg, 5, 9)).toEqual([5, 9, 7]);
    expect(pixelAt(bg, 299, 199)).toEqual([10, 20, 30]);
    expect(group).toMatchObject({ kind: 'group', name: 'Group 1', blendMode: 'pass-through', expanded: true });
    expect(group.opacity).toBeCloseTo(0.8, 2);
    const red = group.children[0] as PsdPixelNode;
    expect(red).toMatchObject({
      name: 'Red square',
      visible: false,
      blendMode: 'multiply',
      isBackground: false,
      offsetX: 40,
      offsetY: 30,
      locks: { transparency: true, pixels: false, position: true },
    });
    expect(red.opacity).toBeCloseTo(0.5, 2);
    expect(red.fillOpacity).toBeCloseTo(0.25, 2);
    expect(pixelAt(red, 45, 32)).toEqual([255, 0, 0, 200]);
    expect(pixelAt(red, 50, 30)).toEqual([0, 0, 0, 0]); // the layer was trimmed to its pixels at (40, 30)
  });

  it('a file without a Background keeps its bottom layer a normal layer', () => {
    const doc = document();
    doc.layers = doc.layers.slice(1);
    const file = readPsdFile(writePsdFile(doc, composite), false);
    expect(file.layers).toHaveLength(1);
    expect(file.layers[0]!.kind).toBe('group');
  });

  it('opens a file without layers from its composite, and lists simplified features', () => {
    const flat = writePsdUint8Array(
      { width: 4, height: 2, imageData: { width: 4, height: 2, data: new Uint8ClampedArray(32).fill(255) } },
      { generateThumbnail: false },
    );
    const file = readPsdFile(flat, false);
    expect(file.layers).toHaveLength(1);
    expect(file.layers[0]).toMatchObject({ name: 'Background', isBackground: true });
    const masked = writePsdUint8Array(
      {
        width: 4,
        height: 2,
        children: [
          {
            name: 'Text',
            text: { text: 'Hi', transform: [1, 0, 0, 1, 0, 0] },
            imageData: { width: 4, height: 2, data: new Uint8ClampedArray(32).fill(200) },
            top: 0,
            left: 0,
            bottom: 2,
            right: 4,
            clipping: true,
          },
        ],
      },
      { generateThumbnail: false, invalidateTextLayers: true },
    );
    const raw = readPsd(masked, { skipLayerImageData: true, skipCompositeImageData: true, useImageData: true });
    expect(raw.children?.[0]?.clipping).toBe(true);
    expect(readPsdFile(masked, false).simplified).toEqual(
      expect.arrayContaining(['text layers opened as pixels', 'clipping masks were ignored']),
    );
  });

  it("converts Photoshop's 16-bit scale", () => {
    expect(psd16.from16(32768)).toBe(65535);
    expect(psd16.from16(16384)).toBe(32768);
    expect(psd16.to16(65535)).toBe(32768);
  });
});
