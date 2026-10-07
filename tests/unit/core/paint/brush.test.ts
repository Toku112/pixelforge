import { describe, expect, it } from 'vitest';
import { DEFAULT_BRUSH, DabSpacer, dabCoverage, stepBrushSize, stepHardness } from '../../../../src/core/paint/brush';
import { StrokeRenderer, dabTiles, type StrokeSetup } from '../../../../src/core/paint/stroke';
import { selectShape } from '../../../../src/core/selection/mask-ops';
import { TILE_SIZE, tileKey } from '../../../../src/core/document/tile';

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
    const a = [...whole.add({ x: 0, y: 0, pressure: 1 }), ...whole.add({ x: 100, y: 0, pressure: 1 })];
    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    expect(a.map((d) => round(d.x))).toEqual(Array.from({ length: 21 }, (_, i) => i * 5));
    const pieces = new DabSpacer(settings);
    const b = [0, 12, 37, 61, 100].flatMap((x) => pieces.add({ x, y: 0, pressure: 1 }));
    expect(b.map((d) => round(d.x))).toEqual(a.map((d) => round(d.x)));
  });

  it('uses pen pressure for size and opacity when asked', () => {
    const spacer = new DabSpacer({ ...DEFAULT_BRUSH, size: 40, pressureSize: true, pressureOpacity: true });
    const [dab] = spacer.add({ x: 0, y: 0, pressure: 0.5 });
    expect(dab).toEqual({ x: 0, y: 0, size: 20, strength: 0.5 });
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
    const dab = { x: 50.5, y: 50.5, size: 10, strength: 1 };
    expect([...r.applyDabs([dab, dab, dab])]).toEqual([tileKey(0, 0)]);
    expect(px(data, 50, 50)).toEqual([128, 0, 128, 255]);
    expect(r.applyDabs([{ x: 400, y: 400, size: 10, strength: 1 }]).size).toBe(0); // no tile there
  });

  it('builds up with Flow', () => {
    const data = tileOf([0, 0, 0, 0]);
    const r = new StrokeRenderer(setup({ flow: 0.5 }));
    r.addTile(0, 0, data);
    const dab = { x: 20.5, y: 20.5, size: 6, strength: 1 };
    r.applyDabs([dab]);
    expect(px(data, 20, 20)).toEqual([255, 0, 0, 128]);
    r.applyDabs([dab]);
    expect(px(data, 20, 20)).toEqual([255, 0, 0, 191]);
  });

  it('erases to transparency, or paints the background colour where alpha cannot change', () => {
    const layer = tileOf([10, 20, 30, 255]);
    const eraser = new StrokeRenderer(setup({ erase: true, color: [255, 255, 255], opacity: 0.5 }));
    eraser.addTile(0, 0, layer);
    eraser.applyDabs([{ x: 10.5, y: 10.5, size: 6, strength: 1 }]);
    expect(px(layer, 10, 10)).toEqual([10, 20, 30, 128]);

    const background = tileOf([10, 20, 30]);
    const bgEraser = new StrokeRenderer(
      setup({ format: { ...rgba, hasAlpha: false }, erase: true, color: [255, 255, 255] }),
    );
    bgEraser.addTile(0, 0, background);
    bgEraser.applyDabs([{ x: 10.5, y: 10.5, size: 6, strength: 1 }]);
    expect(px(background, 10, 10, 3)).toEqual([255, 255, 255]);
  });

  it('keeps alpha with locked transparency, stays inside the selection, and honours layer offsets', () => {
    const data = tileOf([0, 0, 0, 0]);
    const locked = new StrokeRenderer(setup({ lockAlpha: true }));
    locked.addTile(0, 0, data);
    locked.applyDabs([{ x: 10.5, y: 10.5, size: 6, strength: 1 }]);
    expect(px(data, 10, 10)[3]).toBe(0);

    const canvas = { x: 0, y: 0, w: 512, h: 512 };
    const mask = selectShape(null, { kind: 'rect', x: 0, y: 0, w: 100, h: 512 }, 'new', 0, false, canvas)!;
    const inside = tileOf([0, 0, 0, 255]);
    const limited = new StrokeRenderer(setup({ selection: { mask, canvas }, offsetX: 50 }));
    limited.addTile(0, 0, inside); // layer x 0 is document x 50
    limited.applyDabs([{ x: 100, y: 10.5, size: 20, strength: 1 }]);
    expect(px(inside, 45, 10)).toEqual([255, 0, 0, 255]); // document x 95: selected
    expect(px(inside, 55, 10)).toEqual([0, 0, 0, 255]); // document x 105: not selected
    expect(dabTiles([{ x: 300, y: 100, size: 20, strength: 1 }], 50, 0)).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });
});
