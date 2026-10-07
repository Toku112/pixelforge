// Synthetic test documents for rendering tests (shared by harness pages).
import { ImageDocument } from '../../../src/core/document/document';
import { PixelLayer, type LayerBlendMode } from '../../../src/core/document/layers';
import { TiledBuffer } from '../../../src/core/document/tiled-buffer';
import type { BitDepth, ColorMode } from '../../../src/core/document/pixel-format';
import { maxSampleValue, createSampleArray } from '../../../src/core/document/pixel-format';

type Px = (x: number, y: number) => readonly number[];

/** Fills a rectangle of a layer from a function returning normalised samples (colour…, alpha). */
export function paint(layer: PixelLayer, rect: { x: number; y: number; w: number; h: number }, fn: Px): void {
  const { depth, colorChannels, hasAlpha } = layer.buffer.format;
  const spp = colorChannels + (hasAlpha ? 1 : 0);
  const max = maxSampleValue(depth);
  const data = createSampleArray(depth, rect.w * rect.h * spp);
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const v = fn(x, y);
      for (let c = 0; c < spp; c++) {
        const n = v[c] ?? 1;
        data[(y * rect.w + x) * spp + c] = depth === 32 ? n : Math.round(Math.min(1, Math.max(0, n)) * max);
      }
    }
  }
  layer.buffer.writeRegion(rect, data);
}

function addLayer(doc: ImageDocument, parentId?: string) {
  const layer = doc.createPixelLayer();
  doc.insertLayer(layer, parentId);
  return layer;
}

/** Layers with opacity/fill, offsets across tile edges, a hidden layer and both group kinds. */
export function layeredScene(depth: BitDepth = 8, mode: ColorMode = 'rgb', background = true): ImageDocument {
  const doc = new ImageDocument({ width: 600, height: 300, depth, mode });
  const gray = mode === 'grayscale';
  const col = (r: number, g: number, b: number, a: number) =>
    gray ? [0.3 * r + 0.59 * g + 0.11 * b, a] : [r, g, b, a];
  if (background) doc.insertLayer(doc.createBackgroundLayer());

  const a = addLayer(doc);
  paint(a, { x: 0, y: 0, w: 400, h: 200 }, (x, y) => col(1, x / 399, 0.2, 0.25 + 0.75 * (y / 199)));
  doc.updateLayer(a.id, { offsetX: -50, offsetY: 30 });

  const b = addLayer(doc);
  paint(b, { x: 100, y: 50, w: 250, h: 230 }, (x, y) => col(0.1, 0.3, ((x >> 4) + (y >> 4)) & 1 ? 0.9 : 0.4, 0.85));
  doc.updateLayer(b.id, { opacity: 0.6, fillOpacity: 0.8 });

  const hidden = addLayer(doc);
  paint(hidden, { x: 0, y: 0, w: 600, h: 300 }, () => col(0, 0, 0, 1));
  doc.updateLayer(hidden.id, { visible: false });

  const g = doc.createGroup('Isolated');
  doc.insertLayer(g);
  doc.updateLayer(g.id, { opacity: 0.5, blendMode: 'normal' });
  const d = addLayer(doc, g.id);
  paint(d, { x: 0, y: 0, w: 280, h: 300 }, (x) => col(0.1, 0.8, 0.2, 0.3 + 0.7 * (x / 279)));
  doc.updateLayer(d.id, { offsetX: 300, offsetY: -20 });

  const p = doc.createGroup('Pass');
  doc.insertLayer(p);
  doc.updateLayer(p.id, { opacity: 0.7 });
  const e = addLayer(doc, p.id);
  paint(e, { x: 200, y: 100, w: 300, h: 150 }, (x, y) => col(0.9, 0.1, 0.8, ((x + y) % 64) / 63));
  return doc;
}

/**
 * Every place a blend mode can apply: a layer (partial alpha, opacity and fill,
 * offset across tile edges) over a backdrop whose colour and alpha both vary, an
 * isolated group and a layer inside a Pass Through group, and a layer whose
 * unallocated area is an opaque default colour. 32-bit scenes include values above 1.
 */
export function blendScene(mode: LayerBlendMode, depth: BitDepth = 8, colorMode: ColorMode = 'rgb'): ImageDocument {
  const doc = new ImageDocument({ width: 600, height: 300, depth, mode: colorMode });
  const gray = colorMode === 'grayscale';
  const hi = depth === 32 ? 2.5 : 1;
  const col = (r: number, g: number, b: number, a: number) =>
    gray ? [0.3 * r + 0.59 * g + 0.11 * b, a] : [r, g, b, a];

  // Backdrop: opaque on the left, fading to transparent (and empty) on the right.
  const base = addLayer(doc);
  paint(base, { x: 0, y: 0, w: 520, h: 300 }, (x, y) =>
    col((x / 519) * hi, y / 299, ((x >> 3) + (y >> 3)) & 1 ? 0.85 : 0.15, x < 300 ? 1 : 1 - (x - 300) / 220),
  );

  const layer = addLayer(doc);
  paint(layer, { x: 0, y: 0, w: 420, h: 260 }, (x, y) =>
    col(y / 259, 1 - x / 419, (((x + y) % 97) / 96) * hi, 0.3 + (0.7 * ((x * 7 + y * 3) % 50)) / 49),
  );
  doc.updateLayer(layer.id, { offsetX: 40, offsetY: 25, blendMode: mode, opacity: 0.8, fillOpacity: 0.7 });

  const group = doc.createGroup('Isolated');
  doc.insertLayer(group);
  doc.updateLayer(group.id, { blendMode: mode, opacity: 0.9, fillOpacity: 0.6 });
  const inner = addLayer(doc, group.id);
  paint(inner, { x: 0, y: 0, w: 200, h: 200 }, (x, y) => col(0.9, x / 199, 1 - y / 199, 0.4 + 0.6 * (y / 199)));
  doc.updateLayer(inner.id, { offsetX: 330, offsetY: 60 });

  const pass = doc.createGroup('Pass');
  doc.insertLayer(pass);
  doc.updateLayer(pass.id, { opacity: 0.6 });
  const passed = addLayer(doc, pass.id);
  paint(passed, { x: 0, y: 0, w: 150, h: 300 }, (x, y) => col(x / 149, 0.5, y / 299, 0.75));
  doc.updateLayer(passed.id, { offsetX: 200, blendMode: mode });

  // Opaque default colour with one painted tile: both solid and tile blend passes.
  const fill = new PixelLayer(
    doc.newLayerId(),
    'Solid',
    new TiledBuffer(doc.layerFormat(true), {
      memory: doc.memory,
      defaultPixel: (gray ? [0.4, 0.5] : [0.25, 0.6, 0.45, 0.5]).map((v) =>
        depth === 32 ? v : Math.round(v * maxSampleValue(depth)),
      ),
    }),
  );
  doc.insertLayer(fill);
  paint(fill, { x: 256, y: 0, w: 256, h: 256 }, (x, y) => col(1 - y / 255, 0.2, x / 255, 0.65));
  doc.updateLayer(fill.id, { blendMode: mode, opacity: 0.5 });
  return doc;
}

/** A 32-bit document with HDR values (above 1.0) in a transparent layer over white. */
export function hdrScene(): ImageDocument {
  const doc = new ImageDocument({ width: 300, height: 200, depth: 32 });
  doc.insertLayer(doc.createBackgroundLayer());
  const layer = addLayer(doc);
  paint(layer, { x: 20, y: 10, w: 260, h: 180 }, (x, y) => [4 * (x / 259), 0.5, 0.05 + y / 179, 0.2 + 0.8 * (x / 259)]);
  return doc;
}

/** A large opaque pattern for zoomed-out (pyramid) rendering. */
export function patternScene(width = 2048, height = 1024): ImageDocument {
  const doc = new ImageDocument({ width, height });
  const bg = doc.createBackgroundLayer();
  doc.insertLayer(bg);
  paint(bg, { x: 0, y: 0, w: width, h: height }, (x, y) => [
    (x % 256) / 255,
    (y % 256) / 255,
    ((x >> 5) + (y >> 5)) & 1 ? 0.9 : 0.1,
  ]);
  const layer = addLayer(doc);
  paint(layer, { x: 500, y: 200, w: 900, h: 600 }, (x) => [0.2, 0.4, 1, 0.3 + 0.6 * (x / 899)]);
  return doc;
}

/**
 * A heavy document for performance tests: `layers` full-canvas layers (plus a white
 * Background) at partial opacity and odd offsets. Layers reuse a few shared tiles so
 * the test fits in memory, while the renderer still composites every layer.
 */
export function heavyScene(width = 8000, height = 6000, layers = 49): ImageDocument {
  const doc = new ImageDocument({ width, height });
  doc.insertLayer(doc.createBackgroundLayer());
  const tilesX = Math.ceil(width / 256) + 1;
  const tilesY = Math.ceil(height / 256) + 1;
  for (let i = 0; i < layers; i++) {
    const layer = doc.createPixelLayer();
    // A small set of distinct tiles per layer, shared across its grid.
    const shared = [0, 1, 2].map((k) => {
      paint(layer, { x: 0, y: 0, w: 256, h: 256 }, (x, y) => [
        ((x + i * 13) % 256) / 255,
        ((y + k * 40) % 256) / 255,
        (i % 7) / 6,
        ((x ^ y) & 31) < 16 ? 0.15 : 0.6,
      ]);
      return layer.buffer.captureTile(0, 0)!;
    });
    for (let ty = -1; ty < tilesY; ty++)
      for (let tx = -1; tx < tilesX; tx++) layer.buffer.setTile(tx, ty, shared[(tx + ty + 300) % 3]);
    doc.insertLayer(layer);
    doc.updateLayer(layer.id, { opacity: 0.5 + (i % 5) * 0.1, offsetX: (i * 37) % 256, offsetY: (i * 59) % 256 });
  }
  return doc;
}
