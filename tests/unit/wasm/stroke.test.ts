import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, * as ops from '../../../src/wasm/pkg/pixel-ops-st/pixel_ops.js';
import { TILE_SIZE } from '../../../src/core/document/tile';
import type { SampleArray } from '../../../src/core/document/pixel-format';
import type { Dab } from '../../../src/core/paint/brush';
import { StrokeRenderer, wasmCanPaint, type StrokeSetup } from '../../../src/core/paint/stroke';
import { selectShape } from '../../../src/core/selection/mask-ops';
import { seededRandom } from '../../../src/core/random';
import { WasmStrokeRenderer } from '../../../src/workers/wasm-stroke';

const PKG = join(import.meta.dirname, '../../../src/wasm/pkg/pixel-ops-st');

let memory: WebAssembly.Memory;

beforeAll(async () => {
  memory = (await init({ module_or_path: readFileSync(join(PKG, 'pixel_ops_bg.wasm')) })).memory;
});

const base = (over: Partial<StrokeSetup>): StrokeSetup => ({
  format: { depth: 8, colorChannels: 3, hasAlpha: true },
  color: [200, 40, 10],
  erase: false,
  opacity: 0.8,
  flow: 0.6,
  hardness: 0.3,
  mode: 'normal',
  tip: null,
  lockAlpha: false,
  offsetX: 0,
  offsetY: 0,
  selection: null,
  ...over,
});

/** Tiles of a 2 × 2 area with a varied starting picture. */
function tilesFor(setup: StrokeSetup, seed: number): { tx: number; ty: number; data: SampleArray }[] {
  const spp = setup.format.colorChannels + (setup.format.hasAlpha ? 1 : 0);
  const max = setup.format.depth === 8 ? 255 : setup.format.depth === 16 ? 65535 : 1;
  const random = seededRandom(seed);
  const out = [];
  for (let ty = 0; ty < 2; ty++)
    for (let tx = 0; tx < 2; tx++) {
      const n = TILE_SIZE * TILE_SIZE * spp;
      const data =
        setup.format.depth === 8
          ? new Uint8Array(n)
          : setup.format.depth === 16
            ? new Uint16Array(n)
            : new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = random() * max;
        data[i] = setup.format.depth === 32 ? v : Math.round(v);
      }
      out.push({ tx, ty, data });
    }
  return out;
}

function randomDabs(seed: number, count: number, sampled: boolean): Dab[] {
  const random = seededRandom(seed);
  return Array.from({ length: count }, () => ({
    x: 60 + random() * 400,
    y: 60 + random() * 400,
    size: 4 + random() * (sampled ? 120 : 200),
    strength: 0.2 + random() * 0.8,
    angle: random() * 360 - 180,
    roundness: random() < 0.5 ? 1 : 0.2 + random() * 0.8,
    flipX: random() < 0.3,
    flipY: random() < 0.3,
  }));
}

/** Paints the same dabs with both renderers and returns both results. */
function both(setup: StrokeSetup, dabs: Dab[], seed = 1) {
  const a = tilesFor(setup, seed);
  const b = tilesFor(setup, seed);
  const ts = new StrokeRenderer(setup);
  const wasm = new WasmStrokeRenderer(ops.BrushStroke, setup, memory);
  for (const t of a) ts.addTile(t.tx, t.ty, t.data);
  for (const t of b) wasm.addTile(t.tx, t.ty, t.data);
  // In two batches, as a live stroke would.
  const half = Math.floor(dabs.length / 2);
  const changedTs = [...ts.applyDabs(dabs.slice(0, half)), ...ts.applyDabs(dabs.slice(half))];
  const changedWasm = [...wasm.applyDabs(dabs.slice(0, half)), ...wasm.applyDabs(dabs.slice(half))];
  wasm.dispose();
  return { a, b, changedTs: new Set(changedTs), changedWasm: new Set(changedWasm) };
}

function expectSame(setup: StrokeSetup, dabs: Dab[], seed = 1) {
  const { a, b, changedTs, changedWasm } = both(setup, dabs, seed);
  expect(changedWasm).toEqual(changedTs);
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!.data;
    const y = b[i]!.data;
    let differ = 0;
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) differ++;
    expect(differ, `tile ${i}`).toBe(0);
  }
}

describe('brush strokes in WebAssembly', () => {
  it('paints exactly the same pixels as the TypeScript renderer', () => {
    const dabs = randomDabs(3, 40, false);
    for (const depth of [8, 16, 32] as const) {
      const max = depth === 8 ? 255 : depth === 16 ? 65535 : 1;
      const color = [0.8 * max, 0.15 * max, 0.05 * max];
      for (const mode of ['normal', 'behind', 'clear'] as const)
        expectSame(base({ format: { depth, colorChannels: 3, hasAlpha: true }, color, mode }), dabs);
      expectSame(base({ format: { depth, colorChannels: 3, hasAlpha: true }, color, erase: true }), dabs);
      // Where alpha cannot change: locked transparency, and a layer without alpha (the Background).
      expectSame(base({ format: { depth, colorChannels: 3, hasAlpha: true }, color, lockAlpha: true }), dabs);
      expectSame(base({ format: { depth, colorChannels: 3, hasAlpha: false }, color, erase: true }), dabs);
    }
  });

  it('matches for grayscale and CMYK layouts, hard tips, layer offsets and selections', () => {
    const dabs = randomDabs(7, 30, false);
    expectSame(base({ format: { depth: 8, colorChannels: 1, hasAlpha: true }, color: [90], hardness: 1 }), dabs);
    expectSame(
      base({ format: { depth: 16, colorChannels: 4, hasAlpha: true }, color: [1000, 30000, 50000, 2000] }),
      dabs,
    );
    expectSame(base({ offsetX: -37, offsetY: 21 }), dabs);
    // Hard pixels only (the Pencil): round and sampled tips.
    expectSame(base({ aliased: true }), dabs);
    expectSame(
      base({ aliased: true, erase: true, format: { depth: 16, colorChannels: 3, hasAlpha: true }, color: [1, 2, 3] }),
      dabs,
    );
    const canvas = { x: 0, y: 0, w: 512, h: 512 };
    const mask = selectShape(null, { kind: 'ellipse', x: 30, y: 50, w: 300, h: 380 }, 'new', 8, true, canvas)!;
    expectSame(base({ selection: { mask, canvas }, offsetX: 10 }), dabs);
  });

  it('matches for sampled tips (scaled through the pyramid, turned and flipped)', () => {
    const random = seededRandom(11);
    const tip = { width: 37, height: 23, data: Uint8Array.from({ length: 37 * 23 }, () => Math.round(random() * 255)) };
    expectSame(base({ tip }), randomDabs(5, 30, true));
    expectSame(base({ tip, aliased: true }), randomDabs(8, 30, true));
    expectSame(
      base({ tip, format: { depth: 16, colorChannels: 3, hasAlpha: true }, color: [60000, 100, 3000] }),
      randomDabs(6, 20, true),
    );
  });

  it('is used only for strokes it covers', () => {
    expect(wasmCanPaint(base({}))).toBe(true);
    expect(wasmCanPaint(base({ erase: true }))).toBe(true);
    expect(wasmCanPaint(base({ mode: 'multiply' }))).toBe(false);
    expect(wasmCanPaint(base({ wetEdges: true }))).toBe(false);
    expect(wasmCanPaint(base({ varyColor: true }))).toBe(false);
    expect(wasmCanPaint(base({ dual: { tip: null, hardness: 1, mode: 'multiply' } }))).toBe(false);
  });

  it('is much faster than the TypeScript renderer for a big soft brush', () => {
    const setup = base({
      format: { depth: 16, colorChannels: 3, hasAlpha: true },
      color: [40000, 10000, 5000],
      hardness: 0,
      flow: 0.3,
    });
    const dabs: Dab[] = Array.from({ length: 8 }, (_, i) => ({
      x: 300 + i * 30,
      y: 256,
      size: 500,
      strength: 1,
      angle: 0,
      roundness: 1,
      flipX: false,
      flipY: false,
    }));
    const time = (
      make: () => { addTile(tx: number, ty: number, d: SampleArray): void; applyDabs(d: Dab[]): unknown },
    ) => {
      const r = make();
      for (const t of tilesFor(setup, 2)) r.addTile(t.tx, t.ty, t.data);
      const t0 = performance.now();
      r.applyDabs(dabs);
      return (performance.now() - t0) / dabs.length;
    };
    const ts = time(() => new StrokeRenderer(setup));
    const wasm = time(() => new WasmStrokeRenderer(ops.BrushStroke, setup, memory));
    console.log(`500 px soft dab, 16-bit: TypeScript ${ts.toFixed(2)} ms, WebAssembly ${wasm.toFixed(2)} ms`);
    expect(wasm).toBeLessThan(ts / 2);
  });
});
