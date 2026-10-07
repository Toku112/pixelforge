import { describe, expect, it } from 'vitest';
import { TILE_SIZE } from '../../../../src/core/document/tile';
import {
  IDENTITY,
  about,
  affineFromParts,
  affineParts,
  apply,
  invert,
  isValidQuad,
  multiply,
  quadOf,
  rectToQuad,
  rotation,
  scaling,
  translation,
  type Quad,
} from '../../../../src/core/geometry/transform';
import {
  transformLayerPixels,
  transformMask,
  transformSelectedPixels,
  type TransformPixelsSetup,
} from '../../../../src/core/geometry/transform-pixels';
import { selectShape } from '../../../../src/core/selection/mask-ops';
import { Selection } from '../../../../src/core/selection/selection';

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

describe('transform matrices', () => {
  const r = { x: 10, y: 20, w: 100, h: 50 };

  it('maps a rectangle onto any convex quad, and back', () => {
    const q: Quad = [
      { x: 0, y: 0 },
      { x: 200, y: 30 },
      { x: 180, y: 160 },
      { x: 20, y: 120 },
    ];
    const m = rectToQuad(r, q)!;
    quadOf(m, r).forEach((p, i) => close(p, q[i]!));
    const back = invert(m)!;
    close(apply(back, q[2]), { x: 110, y: 70 });
    close(apply(multiply(back, m), { x: 37, y: 41 }), { x: 37, y: 41 });
  });

  it('composes about a point and rejects collapsed or folded quads', () => {
    const m = about({ x: 50, y: 50 }, rotation(Math.PI / 2));
    close(apply(m, { x: 60, y: 50 }), { x: 50, y: 60 });
    expect(invert(scaling(0, 1))).toBeNull();
    expect(
      isValidQuad([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ]),
    ).toBe(true);
    expect(
      isValidQuad([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ]),
    ).toBe(false);
  });

  it('reads scale, rotation and skew back from a quad', () => {
    const parts = { scaleX: 1.5, scaleY: -0.5, angle: 30, skewH: 10, skewV: 5 };
    const m = affineFromParts(parts, r, { x: 300, y: 200 });
    const q = quadOf(m, r);
    close(q[0], { x: 300, y: 200 });
    const read = affineParts(q, r, 5);
    expect(read.scaleX).toBeCloseTo(1.5);
    expect(read.scaleY).toBeCloseTo(-0.5);
    expect(read.angle).toBeCloseTo(30);
    expect(read.skewH).toBeCloseTo(10);
    expect(affineParts(quadOf(IDENTITY, r), r)).toEqual({ scaleX: 1, scaleY: 1, angle: 0, skewH: 0, skewV: 0 });
  });
});

const rgba = { depth: 8 as const, colorChannels: 3, hasAlpha: true };
const canvas = { x: 0, y: 0, w: 200, h: 200 };

/** A layer tile with an opaque square of `color` over (x0, y0)–(x1, y1). */
function squareTile(x0: number, y0: number, x1: number, y1: number, color: number[]) {
  const data = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([...color, 255], (y * TILE_SIZE + x) * 4);
  return { tx: 0, ty: 0, data };
}

function setup(forward: Parameters<typeof invert>[0], more: Partial<TransformPixelsSetup> = {}): TransformPixelsSetup {
  return {
    format: rgba,
    defaultPixel: [0, 0, 0, 0],
    offsetX: 0,
    offsetY: 0,
    inverse: invert(forward)!,
    method: 'bilinear',
    mask: null,
    canvas,
    fill: null,
    ...more,
  };
}

const at = (
  tiles: { tx: number; ty: number; data: Uint8Array | Uint16Array | Float32Array }[],
  x: number,
  y: number,
) => {
  const t = tiles.find((t) => t.tx === Math.floor(x / TILE_SIZE) && t.ty === Math.floor(y / TILE_SIZE));
  if (!t) return [0, 0, 0, 0];
  const i = ((y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)) * 4;
  return [...t.data.slice(i, i + 4)];
};

describe('transforming pixels', () => {
  const src = [squareTile(10, 10, 30, 20, [255, 0, 0])]; // 20 × 10 red

  it('moves by whole pixels exactly and scales up smoothly', () => {
    const moved = transformLayerPixels(setup(translation(5, 7)), src, { x: 0, y: 0, w: 64, h: 64 });
    expect(at(moved, 15, 17)).toEqual([255, 0, 0, 255]);
    expect(at(moved, 14, 17)).toEqual([0, 0, 0, 0]);
    const doubled = transformLayerPixels(setup(about({ x: 10, y: 10 }, scaling(2, 2))), src, canvas);
    expect(at(doubled, 40, 20)).toEqual([255, 0, 0, 255]); // inside the 40 × 20 result
    expect(at(doubled, 51, 31)[3]).toBe(0);
  });

  it('rotates a quarter turn with nearest neighbour exactly', () => {
    const m = about({ x: 10, y: 10 }, rotation(Math.PI / 2)); // (x, y) → (10 − (y − 10), 10 + (x − 10))
    const out = transformLayerPixels(setup(m, { method: 'nearest' }), src, canvas);
    expect(at(out, 5, 25)).toEqual([255, 0, 0, 255]);
    expect(at(out, 5, 5)[3]).toBe(0);
  });

  it('averages the footprint when shrinking a fine checkerboard', () => {
    const data = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++)
        data.set((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * TILE_SIZE + x) * 4);
    const out = transformLayerPixels(setup(scaling(0.25, 0.25), { method: 'bicubic' }), [{ tx: 0, ty: 0, data }], {
      x: 0,
      y: 0,
      w: 16,
      h: 16,
    });
    const v = at(out, 8, 8)[0]!;
    expect(Math.abs(v - 128)).toBeLessThan(3);
  });

  it('moves only the selected pixels, leaving transparency (or the fill colour) behind', () => {
    const mask = selectShape(null, { kind: 'rect', x: 10, y: 10, w: 10, h: 10 }, 'new', 0, false, canvas)!;
    const outputs = [{ tx: 0, ty: 0, data: new Uint8Array(TILE_SIZE * TILE_SIZE * 4) }];
    transformSelectedPixels(setup(translation(50, 0), { mask }), src, outputs);
    expect(at(outputs, 12, 12)[3]).toBe(0); // lifted
    expect(at(outputs, 25, 12)).toEqual([255, 0, 0, 255]); // not selected: stays
    expect(at(outputs, 62, 12)).toEqual([255, 0, 0, 255]); // arrived
    const opaque = { depth: 8 as const, colorChannels: 3, hasAlpha: false };
    const bg = { tx: 0, ty: 0, data: new Uint8Array(TILE_SIZE * TILE_SIZE * 3).fill(100) };
    const out3 = [{ tx: 0, ty: 0, data: new Uint8Array(TILE_SIZE * TILE_SIZE * 3) }];
    transformSelectedPixels(
      setup(translation(50, 0), { mask, format: opaque, defaultPixel: [100, 100, 100], fill: [255, 255, 255] }),
      [bg],
      out3,
    );
    const i = (12 * TILE_SIZE + 12) * 3;
    expect([...out3[0]!.data.slice(i, i + 3)]).toEqual([255, 255, 255]);
  });

  it('moves the selection with the pixels', () => {
    const mask = selectShape(null, { kind: 'rect', x: 10, y: 10, w: 10, h: 10 }, 'new', 0, false, canvas)!;
    const moved = transformMask(mask, invert(translation(50, 5))!, { x: 60, y: 15, w: 10, h: 10 }, canvas)!;
    const sel = new Selection(moved);
    expect([sel.value(60, 15, canvas), sel.value(69, 24, canvas), sel.value(12, 12, canvas)]).toEqual([255, 255, 0]);
    expect(transformMask(mask, invert(translation(500, 0))!, { x: 510, y: 10, w: 10, h: 10 }, canvas)).toBeNull();
  });
});
