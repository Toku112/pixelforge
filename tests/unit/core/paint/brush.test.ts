import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRUSH,
  DabSpacer,
  dabCoverage,
  packPoints,
  stepBrushSize,
  stepHardness,
  strokePoint,
  toTipFrame,
  unpackPoints,
  type Dab,
} from '../../../../src/core/paint/brush';
import { StrokeRenderer, dabTiles, type StrokeSetup } from '../../../../src/core/paint/stroke';
import { selectShape } from '../../../../src/core/selection/mask-ops';
import { TILE_SIZE, tileKey } from '../../../../src/core/document/tile';

const pt = (x: number, y: number, pressure = 1) => strokePoint(x, y, pressure);
/** A round, unturned dab. */
const dab = (x: number, y: number, size: number, more: Partial<Dab> = {}): Dab => ({
  x,
  y,
  size,
  strength: 1,
  angle: 0,
  roundness: 1,
  flipX: false,
  flipY: false,
  ...more,
});

describe('brush maths', () => {
  it('has a solid core and a soft rim set by hardness', () => {
    expect(dabCoverage(0, 10, 1)).toBe(1);
    expect(dabCoverage(8, 10, 1)).toBe(1);
    expect(dabCoverage(11, 10, 1)).toBe(0);
    const edge = dabCoverage(10, 10, 1);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
    // Soft brush: fades from the centre outwards.
    expect(dabCoverage(0, 10, 0)).toBeGreaterThan(0.95);
    const mid = dabCoverage(5, 10, 0);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.8);
    expect(dabCoverage(9, 10, 0)).toBeLessThan(dabCoverage(5, 10, 0));
  });

  it('spaces dabs evenly along the path, also when fed in pieces', () => {
    const settings = { ...DEFAULT_BRUSH, size: 20, spacing: 0.25 }; // a dab every 5 px
    const whole = new DabSpacer(settings);
    const a = [...whole.add(pt(0, 0)), ...whole.add(pt(100, 0))];
    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    expect(a.map((d) => round(d.x))).toEqual(Array.from({ length: 21 }, (_, i) => i * 5));
    const pieces = new DabSpacer(settings);
    const b = [0, 12, 37, 61, 100].flatMap((x) => pieces.add(pt(x, 0)));
    expect(b.map((d) => round(d.x))).toEqual(a.map((d) => round(d.x)));
  });

  it('with Spacing off, puts a dab at every sample that moved (the pointer speed spaces them)', () => {
    const spacer = new DabSpacer({ ...DEFAULT_BRUSH, size: 20, spacingEnabled: false });
    const dabs = [0, 1, 1, 30, 31].flatMap((x) => spacer.add(pt(x, 0)));
    expect(dabs.map((d) => d.x)).toEqual([0, 1, 30, 31]);
  });

  it('uses pen pressure for size and opacity when asked', () => {
    const spacer = new DabSpacer({ ...DEFAULT_BRUSH, size: 40, pressureSize: true, pressureOpacity: true });
    const [first] = spacer.add(pt(0, 0, 0.5));
    expect(first).toMatchObject({ x: 0, y: 0, size: 20, strength: 0.5 });
  });

  it('turns tips counter-clockwise on screen, squashes them by roundness and flips them', () => {
    const turned = dab(0, 0, 20, { angle: 90 });
    // A point straight up on screen (y down) lies along the turned tip's width.
    const [u, v] = toTipFrame(turned, 0, -5);
    expect(u).toBeCloseTo(5);
    expect(v).toBeCloseTo(0);
    expect(toTipFrame(dab(0, 0, 20, { flipX: true }), 3, 0)[0]).toBeCloseTo(-3);
  });

  it('keeps every pen value along the stroke and in recordings', () => {
    const spacer = new DabSpacer({ ...DEFAULT_BRUSH, size: 4, spacing: 0.5 });
    spacer.add({ ...pt(0, 0), tiltX: -40, time: 0 });
    const between = new DabSpacer({ ...DEFAULT_BRUSH, size: 4, spacing: 0.5 });
    expect(between.add(pt(0, 0)).length).toBe(1);
    const points = [
      { ...pt(1, 2, 0.5), tiltX: 30, tiltY: -10, twist: 90, wheel: 0.25, time: 16 },
      { ...pt(3, 4), time: 32 },
    ];
    expect(unpackPoints(packPoints(points), 8)).toEqual(points);
    // The older x, y, pressure form still reads.
    expect(unpackPoints([5, 6, 0.7], 3)).toEqual([pt(5, 6, 0.7)]);
  });

  it('steps size and hardness like the [ ] { } keys', () => {
    expect(stepBrushSize(30, 1)).toBe(35);
    expect(stepBrushSize(30, -1)).toBe(25);
    expect(stepBrushSize(9, 1)).toBe(10);
    expect(stepBrushSize(10, -1)).toBe(9);
    expect(stepBrushSize(100, 1)).toBe(125);
    expect(stepBrushSize(100, -1)).toBe(90);
    expect(stepBrushSize(1, -1)).toBe(1);
    expect(stepBrushSize(5000, 1)).toBe(5000);
    expect(stepHardness(1, -1)).toBe(0.75);
    expect(stepHardness(0.6, 1)).toBe(0.75);
    expect(stepHardness(0, -1)).toBe(0);
  });
});

describe('stroke renderer', () => {
  const rgba = { depth: 8 as const, colorChannels: 3, hasAlpha: true };
  const setup = (over: Partial<StrokeSetup> = {}): StrokeSetup => ({
    format: rgba,
    color: [255, 0, 0],
    erase: false,
    opacity: 1,
    flow: 1,
    hardness: 1,
    mode: 'normal',
    tip: null,
    lockAlpha: false,
    offsetX: 0,
    offsetY: 0,
    selection: null,
    ...over,
  });
  const tileOf = (pixel: number[]) => {
    const data = new Uint8Array(TILE_SIZE * TILE_SIZE * pixel.length);
    for (let i = 0; i < data.length; i++) data[i] = pixel[i % pixel.length]!;
    return data;
  };
  const px = (data: Uint8Array, x: number, y: number, spp = 4) => [
    ...data.slice((y * TILE_SIZE + x) * spp, (y * TILE_SIZE + x + 1) * spp),
  ];

  it('paints with the colour, never past Opacity in one stroke', () => {
    const data = tileOf([0, 0, 255, 255]);
    const r = new StrokeRenderer(setup({ opacity: 0.5 }));
    r.addTile(0, 0, data);
    const d = dab(50.5, 50.5, 10);
    expect([...r.applyDabs([d, d, d])]).toEqual([tileKey(0, 0)]);
    expect(px(data, 50, 50)).toEqual([128, 0, 128, 255]);
    expect(r.applyDabs([dab(400, 400, 10)]).size).toBe(0); // no tile there
  });

  it('builds up with Flow', () => {
    const data = tileOf([0, 0, 0, 0]);
    const r = new StrokeRenderer(setup({ flow: 0.5 }));
    r.addTile(0, 0, data);
    const d = dab(20.5, 20.5, 6);
    r.applyDabs([d]);
    expect(px(data, 20, 20)).toEqual([255, 0, 0, 128]);
    r.applyDabs([d]);
    expect(px(data, 20, 20)).toEqual([255, 0, 0, 191]);
  });

  it('erases to transparency, or paints the background colour where alpha cannot change', () => {
    const layer = tileOf([10, 20, 30, 255]);
    const eraser = new StrokeRenderer(setup({ erase: true, color: [255, 255, 255], opacity: 0.5 }));
    eraser.addTile(0, 0, layer);
    eraser.applyDabs([dab(10.5, 10.5, 6)]);
    expect(px(layer, 10, 10)).toEqual([10, 20, 30, 128]);

    const background = tileOf([10, 20, 30]);
    const bgEraser = new StrokeRenderer(
      setup({ format: { ...rgba, hasAlpha: false }, erase: true, color: [255, 255, 255] }),
    );
    bgEraser.addTile(0, 0, background);
    bgEraser.applyDabs([dab(10.5, 10.5, 6)]);
    expect(px(background, 10, 10, 3)).toEqual([255, 255, 255]);
  });

  it('keeps alpha with locked transparency, stays inside the selection, and honours layer offsets', () => {
    const data = tileOf([0, 0, 0, 0]);
    const locked = new StrokeRenderer(setup({ lockAlpha: true }));
    locked.addTile(0, 0, data);
    locked.applyDabs([dab(10.5, 10.5, 6)]);
    expect(px(data, 10, 10)[3]).toBe(0);

    const canvas = { x: 0, y: 0, w: 512, h: 512 };
    const mask = selectShape(null, { kind: 'rect', x: 0, y: 0, w: 100, h: 512 }, 'new', 0, false, canvas)!;
    const inside = tileOf([0, 0, 0, 255]);
    const limited = new StrokeRenderer(setup({ selection: { mask, canvas }, offsetX: 50 }));
    limited.addTile(0, 0, inside); // layer x 0 is document x 50
    limited.applyDabs([dab(100, 10.5, 20)]);
    expect(px(inside, 45, 10)).toEqual([255, 0, 0, 255]); // document x 95: selected
    expect(px(inside, 55, 10)).toEqual([0, 0, 0, 255]); // document x 105: not selected
    expect(dabTiles([dab(300, 100, 20)], 50, 0)).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it('paints elliptical tips at their angle', () => {
    const data = tileOf([0, 0, 0, 0]);
    const r = new StrokeRenderer(setup());
    r.addTile(0, 0, data);
    // 40 px wide, 10 px high, turned 90°: tall and narrow.
    r.applyDabs([dab(100, 100, 40, { roundness: 0.25, angle: 90 })]);
    expect(px(data, 100, 85)[3]).toBe(255); // 15 px up: inside
    expect(px(data, 112, 100)[3]).toBe(0); // 12 px right: outside
  });

  it('paints sampled tips scaled to the brush size', () => {
    // An 8 × 4 tip: left half full, right half empty.
    const tipData = new Uint8Array(32);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) tipData[y * 8 + x] = 255;
    const data = tileOf([0, 0, 0, 0]);
    const r = new StrokeRenderer(setup({ tip: { width: 8, height: 4, data: tipData } }));
    r.addTile(0, 0, data);
    r.applyDabs([dab(100, 100, 80)]); // tip 10× larger: 80 × 40
    expect(px(data, 80, 100)[3]).toBe(255); // left part
    expect(px(data, 120, 100)[3]).toBe(0); // right part
    expect(px(data, 80, 130)[3]).toBe(0); // below the tip
    // Far smaller than the tip: read from the halved copies, still about half covered on the left.
    const small = tileOf([0, 0, 0, 0]);
    const r2 = new StrokeRenderer(setup({ tip: { width: 8, height: 4, data: tipData } }));
    r2.addTile(0, 0, small);
    r2.applyDabs([dab(10, 10, 4)]);
    expect(px(small, 8, 9)[3]).toBeGreaterThan(px(small, 11, 9)[3]!);
  });

  it('blends paint with the pixels by mode; Behind and Clear', () => {
    const shade = (mode: StrokeSetup['mode'], pixel: number[], color: number[], over: Partial<StrokeSetup> = {}) => {
      const data = tileOf(pixel);
      const r = new StrokeRenderer(setup({ mode, color, ...over }));
      r.addTile(0, 0, data);
      r.applyDabs([dab(10.5, 10.5, 6)]);
      return px(data, 10, 10, pixel.length);
    };
    expect(shade('multiply', [200, 100, 50, 255], [128, 255, 0])).toEqual([100, 100, 0, 255]);
    // On transparent pixels the blend has nothing to act on: the paint shows as is.
    expect(shade('multiply', [0, 0, 0, 0], [128, 255, 0])).toEqual([128, 255, 0, 255]);
    expect(shade('screen', [0, 0, 0], [128, 64, 32], { format: { ...rgba, hasAlpha: false } })).toEqual([128, 64, 32]);
    expect(shade('behind', [10, 20, 30, 255], [255, 0, 0])).toEqual([10, 20, 30, 255]); // opaque: nothing behind
    expect(shade('behind', [10, 20, 30, 0], [255, 0, 0])).toEqual([255, 0, 0, 255]);
    expect(shade('clear', [10, 20, 30, 255], [255, 0, 0])[3]).toBe(0);
    expect(shade('clear', [10, 20, 30], [255, 0, 0], { format: { ...rgba, hasAlpha: false } })).toEqual([10, 20, 30]);
    expect(shade('luminosity', [255, 0, 0, 255], [0, 0, 0])).toEqual([0, 0, 0, 255]);
    // Dissolve: each pixel either fully painted or untouched, about half of them at 50 %.
    const data = tileOf([0, 0, 0, 0]);
    const r = new StrokeRenderer(setup({ mode: 'dissolve', opacity: 0.5 }));
    r.addTile(0, 0, data);
    r.applyDabs([dab(100, 100, 60, { roundness: 1 })]);
    let full = 0;
    let none = 0;
    for (let y = 90; y < 110; y++)
      for (let x = 90; x < 110; x++) {
        const a = px(data, x, y)[3]!;
        if (a === 255) full++;
        else if (a === 0) none++;
      }
    expect(full + none).toBe(400);
    expect(full).toBeGreaterThan(150);
    expect(full).toBeLessThan(250);
  });

  it('aliased (the Pencil): hard pixels only, one pixel for a 1 px dab', () => {
    const one = tileOf([0, 0, 0, 0]);
    const pencil = new StrokeRenderer(setup({ aliased: true, hardness: 0 }));
    pencil.addTile(0, 0, one);
    pencil.applyDabs([dab(10.5, 10.5, 1)]);
    let painted = 0;
    for (let i = 3; i < one.length; i += 4) if (one[i]! > 0) painted++;
    expect(painted).toBe(1);
    expect(px(one, 10, 10)).toEqual([255, 0, 0, 255]);
    const big = tileOf([0, 0, 0, 0]);
    const hard = new StrokeRenderer(setup({ aliased: true, hardness: 0 }));
    hard.addTile(0, 0, big);
    hard.applyDabs([dab(40.3, 40.7, 13), dab(47.1, 44.2, 13)]);
    for (let i = 3; i < big.length; i += 4) expect([0, 255]).toContain(big[i]);
  });

  it('keeps the colour and opacity of each dab when they vary', () => {
    const data = tileOf([0, 0, 0, 0]);
    const r = new StrokeRenderer(setup({ varyColor: true, varyOpacity: true, opacity: 1 }));
    r.addTile(0, 0, data);
    r.applyDabs([dab(20.5, 20.5, 6, { color: [0, 255, 0], opacity: 0.5 })]);
    expect(px(data, 20, 20)).toEqual([0, 255, 0, 128]); // its own colour, at its own opacity
    r.applyDabs([dab(20.5, 20.5, 6, { color: [0, 0, 255], opacity: 1 })]);
    expect(px(data, 20, 20)).toEqual([0, 0, 255, 255]); // later paint covers it; the higher opacity counts
  });
});
