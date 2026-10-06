import { describe, expect, it } from 'vitest';
import { ImageDocument } from '../../../../src/core/document/document';
import {
  compositeToSamples,
  flatten,
  isOpaque,
  planFromDocument,
  UnsupportedBlendModeError,
} from '../../../../src/engine/cpu/flatten';

function doc8(withBackground = true) {
  const doc = new ImageDocument({ width: 4, height: 2 });
  if (withBackground) doc.insertLayer(doc.createBackgroundLayer());
  return doc;
}

/** Flattens and returns straight 8-bit RGBA of pixel (x, y). */
function pixel(doc: ImageDocument, x: number, y: number): number[] {
  const out = compositeToSamples(flatten(planFromDocument(doc)), 8, true);
  const i = (y * doc.width + x) * 4;
  return [...out.subarray(i, i + 4)];
}

function paint(doc: ImageDocument, rgba: number[], opts: { x?: number; y?: number; w?: number; h?: number } = {}) {
  const layer = doc.createPixelLayer();
  doc.insertLayer(layer);
  const r = { x: opts.x ?? 0, y: opts.y ?? 0, w: opts.w ?? doc.width, h: opts.h ?? doc.height };
  layer.buffer.writeRegion(
    r,
    new Uint8Array(r.w * r.h * 4).map((_, i) => rgba[i % 4]!),
  );
  return layer;
}

describe('CPU flatten (Normal blend)', () => {
  it('shows the white Background by itself', () => {
    const doc = doc8();
    expect(pixel(doc, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(isOpaque(flatten(planFromDocument(doc)))).toBe(true);
  });

  it('composites a 50% opaque red layer over white', () => {
    const doc = doc8();
    paint(doc, [255, 0, 0, 128]);
    // a = 128/255; C = 255·a + 255·(1−a) for R; G,B = 255·(1−a) = 127.
    expect(pixel(doc, 1, 1)).toEqual([255, 127, 127, 255]);
  });

  it('applies layer opacity and fill opacity multiplicatively', () => {
    const doc = doc8();
    const layer = paint(doc, [0, 0, 0, 255]);
    doc.updateLayer(layer.id, { opacity: 0.5, fillOpacity: 0.5 });
    expect(pixel(doc, 0, 0)).toEqual([191, 191, 191, 255]); // 255·(1 − 0.25) = 191.25
  });

  it('keeps transparency without a Background and un-premultiplies the result', () => {
    const doc = doc8(false);
    paint(doc, [0, 0, 255, 255], { w: 2 });
    paint(doc, [255, 0, 0, 128]);
    // Left: red 50% over opaque blue. Right: red 50% over nothing.
    expect(pixel(doc, 0, 0)).toEqual([128, 0, 127, 255]);
    expect(pixel(doc, 3, 0)).toEqual([255, 0, 0, 128]);
    expect(isOpaque(flatten(planFromDocument(doc)))).toBe(false);
  });

  it('honours layer offsets and hidden layers', () => {
    const doc = doc8();
    const layer = paint(doc, [0, 0, 0, 255], { w: 1, h: 1 });
    doc.updateLayer(layer.id, { offsetX: 2, offsetY: 1 });
    expect(pixel(doc, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(doc, 2, 1)).toEqual([0, 0, 0, 255]);
    doc.updateLayer(layer.id, { visible: false });
    expect(pixel(doc, 2, 1)).toEqual([255, 255, 255, 255]);
  });

  it('isolates normal groups and mixes pass-through groups by opacity', () => {
    // Two 50% black layers inside a group at 50%.
    const build = (mode: 'normal' | 'pass-through') => {
      const doc = doc8();
      const g = doc.createGroup();
      doc.insertLayer(g);
      for (let i = 0; i < 2; i++) {
        const l = doc.createPixelLayer();
        doc.insertLayer(l, g.id);
        l.buffer.writeRegion(
          { x: 0, y: 0, w: 4, h: 2 },
          new Uint8Array(32).map((_, j) => (j % 4 === 3 ? 128 : 0)),
        );
      }
      doc.updateLayer(g.id, { opacity: 0.5, blendMode: mode });
      return doc;
    };
    // a = 128/255. Isolated: group alpha = 1 − (1−a)² = 0.75196; × 0.5 → 255·(1 − 0.37598) = 159.1.
    expect(pixel(build('normal'), 0, 0)).toEqual([159, 159, 159, 255]);
    // Pass-through: backdrop after the children = 255·(1−a)² = 63.25; 50 % mix with 255 → 159.1.
    // (With Normal blending both paths agree; they differ once other blend modes are involved.)
    expect(pixel(build('pass-through'), 0, 0)).toEqual([159, 159, 159, 255]);
  });

  it('works in 16-bit', () => {
    const doc = new ImageDocument({ width: 2, height: 1, depth: 16 });
    doc.insertLayer(doc.createBackgroundLayer());
    const l = doc.createPixelLayer();
    doc.insertLayer(l);
    l.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint16Array([0, 0, 0, 32768]));
    const out = compositeToSamples(flatten(planFromDocument(doc)), 16, false);
    expect(out.length).toBe(6);
    expect(out[0]).toBe(Math.round(65535 * (1 - 32768 / 65535))); // 32767
    expect(out[3]).toBe(65535);
  });

  it('flattens a sub-rectangle', () => {
    const doc = doc8();
    paint(doc, [0, 0, 0, 255], { x: 3, y: 1, w: 1, h: 1 });
    const c = flatten(planFromDocument(doc), { x: 3, y: 1, w: 1, h: 1 });
    expect([...compositeToSamples(c, 8, true)]).toEqual([0, 0, 0, 255]);
  });

  it('refuses blend modes that are not implemented yet', () => {
    const doc = doc8();
    const l = paint(doc, [0, 0, 0, 255]);
    doc.updateLayer(l.id, { blendMode: 'multiply' });
    expect(() => flatten(planFromDocument(doc))).toThrow(UnsupportedBlendModeError);
  });
});
