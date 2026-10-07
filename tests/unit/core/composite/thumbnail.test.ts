import { describe, expect, it } from 'vitest';
import { renderThumbnail, thumbnailSize, type ThumbnailSource } from '../../../../src/core/composite/thumbnail';
import { ImageDocument } from '../../../../src/core/document/document';
import type { PixelLayer } from '../../../../src/core/document/layers';
import type { BitDepth, ColorMode } from '../../../../src/core/document/pixel-format';
import { createSampleArray, maxSampleValue } from '../../../../src/core/document/pixel-format';

function sourceOf(layer: PixelLayer): ThumbnailSource {
  return {
    format: layer.buffer.format,
    defaultPixel: layer.buffer.defaultPixel,
    tiles: [...layer.buffer.tiles()].map(([tx, ty, t]) => ({ tx, ty, data: t.data })),
    offsetX: layer.offsetX,
    offsetY: layer.offsetY,
  };
}

/** A document with one layer filled in `rect` with normalised `pixel` (colour…, alpha). */
function layerWith(
  rect: { x: number; y: number; w: number; h: number },
  pixel: number[],
  depth: BitDepth = 8,
  mode: ColorMode = 'rgb',
) {
  const doc = new ImageDocument({ width: 400, height: 200, depth, mode });
  const layer = doc.createPixelLayer();
  doc.insertLayer(layer);
  const max = maxSampleValue(depth);
  const data = createSampleArray(depth, rect.w * rect.h * pixel.length);
  for (let i = 0; i < data.length; i++) {
    const v = pixel[i % pixel.length]!;
    data[i] = depth === 32 ? v : Math.round(v * max);
  }
  layer.buffer.writeRegion(rect, data);
  return { doc, layer };
}

const px = (t: { width: number; data: Uint8ClampedArray }, x: number, y: number) => [
  ...t.data.slice((y * t.width + x) * 4, (y * t.width + x) * 4 + 4),
];

describe('layer thumbnails', () => {
  it('fits the document area inside the box, keeping its shape', () => {
    expect(thumbnailSize(400, 200, 40)).toEqual({ width: 40, height: 20 });
    expect(thumbnailSize(100, 3000, 40)).toEqual({ width: 1, height: 40 });
  });

  it('shows the layer content where it is, transparent elsewhere', () => {
    const { doc, layer } = layerWith({ x: 0, y: 0, w: 200, h: 100 }, [1, 0, 0, 1]);
    const t = renderThumbnail(sourceOf(layer), doc.canvasRect, 40, 20);
    expect(px(t, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(px(t, 30, 15)).toEqual([0, 0, 0, 0]);
  });

  it('averages partly covered thumbnail pixels without darkening them', () => {
    // Half of each 10×10 footprint at x = 19 is covered (layer ends at x = 195).
    const { doc, layer } = layerWith({ x: 0, y: 0, w: 195, h: 200 }, [0, 0.5, 1, 1]);
    const t = renderThumbnail(sourceOf(layer), doc.canvasRect, 40, 20);
    const p = px(t, 19, 5);
    expect(p.slice(0, 3)).toEqual([0, 128, 255]);
    expect(p[3]).toBeGreaterThan(100);
    expect(p[3]).toBeLessThan(155);
  });

  it('honours layer offsets', () => {
    const { doc, layer } = layerWith({ x: 0, y: 0, w: 100, h: 100 }, [0, 1, 0, 1]);
    doc.updateLayer(layer.id, { offsetX: 300, offsetY: 100 });
    const t = renderThumbnail(sourceOf(layer), doc.canvasRect, 40, 20);
    expect(px(t, 2, 2)[3]).toBe(0);
    expect(px(t, 35, 15)).toEqual([0, 255, 0, 255]);
  });

  it('handles 16-bit, grayscale and 32-bit (HDR) layers', () => {
    const l16 = layerWith({ x: 0, y: 0, w: 400, h: 200 }, [0.5, 0.25, 1, 1], 16);
    expect(px(renderThumbnail(sourceOf(l16.layer), l16.doc.canvasRect, 4, 2), 1, 1)).toEqual([128, 64, 255, 255]);
    const gray = layerWith({ x: 0, y: 0, w: 400, h: 200 }, [0.2, 1], 8, 'grayscale');
    expect(px(renderThumbnail(sourceOf(gray.layer), gray.doc.canvasRect, 4, 2), 0, 0)).toEqual([51, 51, 51, 255]);
    // 32-bit is linear: mid-grey 0.18 encodes to 118 in sRGB; values above 1 show as white.
    const hdr = layerWith({ x: 0, y: 0, w: 400, h: 200 }, [0.18, 4, 0, 1], 32);
    expect(px(renderThumbnail(sourceOf(hdr.layer), hdr.doc.canvasRect, 4, 2), 3, 1)).toEqual([118, 255, 0, 255]);
  });

  it('shows the Background (no alpha, unallocated tiles) as its colour', () => {
    const doc = new ImageDocument({ width: 400, height: 200 });
    const bg = doc.createBackgroundLayer();
    doc.insertLayer(bg);
    expect(px(renderThumbnail(sourceOf(bg), doc.canvasRect, 4, 2), 1, 1)).toEqual([255, 255, 255, 255]);
  });
});
