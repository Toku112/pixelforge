import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../../../../src/core/commands/command';
import { srgbToLinear } from '../../../../src/core/color/srgb';
import { History } from '../../../../src/core/history/history';
import {
  FOREGROUND_TO_BACKGROUND,
  GRADIENT_STEPS,
  defaultGradients,
  gradientPosition,
  gradientSamples,
  gradientTable,
  noiseGradient,
  parseGradient,
  resolveGradient,
  solidGradient,
  type GradientGeometry,
  type GradientMethod,
  type SolidGradient,
} from '../../../../src/core/paint/gradient';
import { createContext, withBackground } from '../helpers';

const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 1, g: 1, b: 1 };
const blackWhite = (smoothness = 0, midpoint = 0.5): SolidGradient => ({
  ...solidGradient('BW', [
    { location: 0, color: BLACK, midpoint },
    { location: 1, color: WHITE },
  ]),
  smoothness,
});

/** The table's red value (and alpha) at a position 0–1. */
function at(table: Float32Array, t: number): { v: number; a: number } {
  const i = Math.round(t * (GRADIENT_STEPS - 1));
  return { v: table[i * 4]!, a: table[i * 4 + 3]! };
}

describe('gradient colours', () => {
  it('Classic without smoothness mixes the stored values in straight lines; the midpoint moves the half-way mix', () => {
    const table = gradientTable(blackWhite(0), 'classic');
    expect(at(table, 0).v).toBe(0);
    expect(at(table, 0.25).v).toBeCloseTo(0.25, 3);
    expect(at(table, 1).v).toBe(1);
    const moved = gradientTable(blackWhite(0, 0.25), 'classic');
    expect(at(moved, 0.25).v).toBeCloseTo(0.5, 2);
    expect(at(moved, 0.6).v).toBeGreaterThan(0.6);
  });

  it('smoothness rounds off the ends (a gentle S that still passes half way at the midpoint)', () => {
    const table = gradientTable(blackWhite(1), 'classic');
    // Catmull-Rom with the ends repeated: 0.5u + 1.5u² − u³.
    expect(at(table, 0.25).v).toBeCloseTo(0.203, 2);
    expect(at(table, 0.5).v).toBeCloseTo(0.5, 2);
    expect(at(table, 0.75).v).toBeCloseTo(0.797, 2);
    // A three-stop gradient does not overshoot past its stops.
    const peak = gradientTable(
      {
        ...solidGradient('BWB', [
          { location: 0, color: BLACK },
          { location: 0.5, color: WHITE },
          { location: 1, color: BLACK },
        ]),
        smoothness: 1,
      },
      'classic',
    );
    for (let i = 0; i < peak.length; i += 4) expect(peak[i]!).toBeLessThanOrEqual(1);
    expect(at(peak, 0.5).v).toBeCloseTo(1, 5);
  });

  it('methods: Perceptual mixes darker than Classic, Linear lighter; Stripes steps; Smooth eases', () => {
    const mid = (method: GradientMethod) => at(gradientTable(blackWhite(0), method), 0.5).v;
    expect(mid('perceptual')).toBeCloseTo(0.389, 2); // Oklab L 0.5
    expect(mid('classic')).toBeCloseTo(0.5, 2);
    expect(mid('linear')).toBeCloseTo(0.735, 2); // half the light
    const stripes = gradientTable(blackWhite(0), 'stripes');
    expect(at(stripes, 0.49).v).toBe(0);
    expect(at(stripes, 0.51).v).toBe(1);
    const smooth = gradientTable(blackWhite(0), 'smooth');
    const perceptual = gradientTable(blackWhite(0), 'perceptual');
    expect(at(smooth, 0.1).v).toBeLessThan(at(perceptual, 0.1).v);
    expect(at(smooth, 0.9).v).toBeGreaterThan(at(perceptual, 0.9).v);
  });

  it('opacity stops apply only with Transparency; foreground/background stops take the current colours', () => {
    const fading = solidGradient(
      'Fade',
      [{ location: 0, color: BLACK }],
      [
        { location: 0, midpoint: 0.5, opacity: 1 },
        { location: 1, midpoint: 0.5, opacity: 0 },
      ],
    );
    fading.smoothness = 0;
    expect(at(gradientTable(fading, 'classic'), 0.5).a).toBeCloseTo(0.5, 2);
    expect(at(gradientTable(fading, 'classic', false), 0.5).a).toBe(1);
    const red = { r: 1, g: 0, b: 0 };
    const resolved = resolveGradient(FOREGROUND_TO_BACKGROUND, red, WHITE) as SolidGradient;
    expect(resolved.colorStops.map((s) => s.color)).toEqual([red, WHITE]);
    expect(FOREGROUND_TO_BACKGROUND.colorStops[0]!.color).toEqual(BLACK); // the preset is unchanged
  });

  it('noise gradients repeat for a seed and stay within their ranges', () => {
    const a = gradientTable(noiseGradient('N', 7), 'perceptual');
    expect(gradientTable(noiseGradient('N', 7), 'perceptual')).toEqual(a);
    expect(gradientTable(noiseGradient('N', 8), 'perceptual')).not.toEqual(a);
    const narrow = { ...noiseGradient('N', 7), min: [0.5, 0, 0.2] as [number, number, number] };
    narrow.max = [0.5, 0, 0.4];
    const t = gradientTable(narrow, 'perceptual');
    for (let i = 0; i < t.length; i += 4) {
      expect(t[i]!).toBeCloseTo(0.5, 5);
      expect(t[i + 1]!).toBe(0);
      expect(t[i + 2]!).toBeGreaterThanOrEqual(0.2 - 1e-6);
      expect(t[i + 2]!).toBeLessThanOrEqual(0.4 + 1e-6);
      expect(t[i + 3]!).toBe(1); // no transparency unless asked
    }
  });

  it('converts tables to grayscale and 32-bit (linear) channel values', () => {
    const table = Float32Array.of(1, 0, 0, 0.5, 0.5, 0.5, 0.5, 1);
    expect([...gradientSamples(table, 'grayscale', 8)].map((v) => +v.toFixed(3))).toEqual([0.299, 0.5, 0.5, 1]);
    const linear = gradientSamples(table, 'rgb', 32);
    expect(linear[4]).toBeCloseTo(srgbToLinear(0.5));
    expect(() => gradientSamples(table, 'cmyk', 8)).toThrow(/colour management/);
  });

  it('reads gradients back, clamping values; our defaults are all valid', () => {
    const g = parseGradient({
      name: 'X',
      colorStops: [{ location: 2, midpoint: 0, color: { r: 2, g: 0.5, b: -1 }, kind: 'foreground' }],
      smoothness: 9,
    }) as SolidGradient;
    expect(g.colorStops[0]).toEqual({ location: 1, midpoint: 0.05, color: { r: 1, g: 0.5, b: 0 }, kind: 'foreground' });
    expect(g.opacityStops).toHaveLength(2);
    expect(g.smoothness).toBe(1);
    expect(() => parseGradient({ colorStops: [] })).toThrow(/no colour stops/);
    const groups = defaultGradients();
    const ids = groups.flatMap((gr) => gr.gradients.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const gr of groups) for (const e of gr.gradients) expect(parseGradient(e.gradient)).toEqual(e.gradient);
  });
});

describe('gradient shapes', () => {
  const geo = (shape: GradientGeometry['shape'], reverse = false): GradientGeometry => ({
    shape,
    start: { x: 0, y: 0 },
    end: { x: 10, y: 0 },
    reverse,
  });

  it('linear, reflected, radial and diamond', () => {
    expect(gradientPosition(geo('linear'), 5, 7)).toBeCloseTo(0.5);
    expect(gradientPosition(geo('linear'), -3, 0)).toBe(0);
    expect(gradientPosition(geo('linear'), 12, 0)).toBe(1);
    expect(gradientPosition(geo('linear', true), 2, 0)).toBeCloseTo(0.8);
    expect(gradientPosition(geo('reflected'), -5, 0)).toBeCloseTo(0.5);
    expect(gradientPosition(geo('radial'), 0, 5)).toBeCloseTo(0.5);
    expect(gradientPosition(geo('radial'), 6, 8)).toBe(1);
    expect(gradientPosition(geo('diamond'), 2.5, 2.5)).toBeCloseTo(0.5);
    expect(gradientPosition(geo('diamond'), 0, -10)).toBe(1);
  });

  it('angle sweeps counter-clockwise on screen from the drag direction', () => {
    expect(gradientPosition(geo('angle'), 5, 0)).toBeCloseTo(0);
    expect(gradientPosition(geo('angle'), 0, -5)).toBeCloseTo(0.25); // above (y down)
    expect(gradientPosition(geo('angle'), -5, 0)).toBeCloseTo(0.5);
    expect(gradientPosition(geo('angle'), 0, 5)).toBeCloseTo(0.75);
    expect(gradientPosition(geo('angle', true), 0, 5)).toBeCloseTo(0.25);
  });

  it('a click without a drag is the start colour everywhere', () => {
    const g = { ...geo('linear'), end: { x: 0, y: 0 } };
    expect(gradientPosition(g, 50, 50)).toBe(0);
  });
});

describe('the Gradient command', () => {
  function setup() {
    const env = withBackground(createContext({ width: 40, height: 10 }));
    const history = new History(env.doc);
    const run = (params: CommandDescriptor['params']) =>
      history.execute(env.registry.create(env.ctx, { name: 'gradient', params }));
    return { ...env, history, run };
  }
  const base = {
    gradient: blackWhite(0) as unknown as CommandDescriptor['params'],
    method: 'classic',
    start: { x: 0, y: 0 },
    end: { x: 40, y: 0 },
    dither: false,
  };

  it('fills the layer along the drag as one undoable "Gradient" step', async () => {
    const { doc, history, run } = setup();
    await run(base);
    expect(history.entries.at(-1)!.label).toBe('Gradient');
    const bg = doc.background!.buffer;
    // Pixel centres: x + 0.5 of 40.
    expect(bg.getPixel(0, 5)).toEqual([3, 3, 3]);
    expect(bg.getPixel(20, 5)[0]).toBe(131);
    expect(bg.getPixel(39, 0)).toEqual([252, 252, 252]);
    await history.undo();
    expect(bg.getPixel(0, 5)).toEqual([255, 255, 255]);
  });

  it('stays inside the selection, blends with a mode and opacity, and keeps locked transparency', async () => {
    const { doc, history, run, registry, ctx } = setup();
    await history.execute(
      registry.create(ctx, {
        name: 'selectShape',
        params: { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 0, y: 0, w: 20, h: 10 } },
      }),
    );
    await run({ ...base, mode: 'multiply', opacity: 0.5 });
    const bg = doc.background!.buffer;
    expect(bg.getPixel(0, 0)[0]).toBe(129); // white × near black, half way
    expect(bg.getPixel(30, 0)).toEqual([255, 255, 255]);

    const layer = doc.createPixelLayer();
    doc.insertLayer(layer);
    doc.setActiveLayer(layer.id);
    layer.buffer.writeRegion({ x: 2, y: 2, w: 1, h: 1 }, new Uint8Array([255, 0, 0, 128]));
    layer.locks = { ...layer.locks, transparency: true };
    await history.execute(registry.create(ctx, { name: 'selectAll', params: {} }));
    await run(base);
    expect(layer.buffer.getPixel(2, 2)).toEqual([16, 16, 16, 128]); // 2.5 / 40 of the way
    expect(layer.buffer.getPixel(10, 5)).toEqual([0, 0, 0, 0]);
  });

  it('works in 16-bit, 32-bit and Grayscale documents', async () => {
    const cases = [
      ['rgb', 16, [32768, 32768, 32768]],
      ['rgb', 32, [srgbToLinear(0.5), srgbToLinear(0.5), srgbToLinear(0.5)]],
      ['grayscale', 8, [128]],
    ] as const;
    for (const [mode, depth, expected] of cases) {
      const env = withBackground(createContext({ width: 40, height: 10, mode, depth }));
      const history = new History(env.doc);
      // From x = −19.5 to 60.5: pixel 20's centre is exactly half way.
      await history.execute(
        env.registry.create(env.ctx, {
          name: 'gradient',
          params: { ...base, start: { x: -19.5, y: 0 }, end: { x: 60.5, y: 0 } },
        }),
      );
      const got = env.doc.background!.buffer.getPixel(20, 5);
      expected.forEach((v, c) => expect(got[c], `${mode} ${depth}`).toBeCloseTo(v, depth === 32 ? 4 : -1));
    }
  });

  it('reports progress on large fills and leaves the layer unchanged when cancelled', async () => {
    const env = withBackground(createContext({ width: 3000, height: 1000 }));
    const fractions: number[] = [];
    const task = { cancelled: false, progress: (f: number) => fractions.push(f) };
    const history = new History(env.doc);
    await history.execute(env.registry.create({ ...env.ctx, task }, { name: 'gradient', params: base }));
    expect(fractions.length).toBeGreaterThan(1);
    expect(fractions.at(-1)).toBe(1);
    const stop = {
      cancelled: false,
      progress: () => {
        stop.cancelled = true; // Esc after the first chunk
      },
    };
    const first = env.doc.background!.buffer.getPixel(0, 0); // in the first chunk
    const before = env.doc.background!.buffer.getPixel(2999, 999);
    await expect(
      history.execute(
        env.registry.create({ ...env.ctx, task: stop }, { name: 'gradient', params: { ...base, reverse: true } }),
      ),
    ).rejects.toThrow('Cancelled');
    expect(env.doc.background!.buffer.getPixel(0, 0)).toEqual(first); // the first chunk undone
    expect(env.doc.background!.buffer.getPixel(2999, 999)).toEqual(before);
  });

  it('Behind paints under existing pixels; Clear takes them away; neither touches the Background', async () => {
    const { doc, run } = setup();
    await run({ ...base, mode: 'clear' });
    expect(doc.background!.buffer.getPixel(5, 5)).toEqual([255, 255, 255]);
    const layer = doc.createPixelLayer();
    doc.insertLayer(layer);
    doc.setActiveLayer(layer.id);
    layer.buffer.writeRegion({ x: 2, y: 2, w: 1, h: 1 }, new Uint8Array([255, 0, 0, 128]));
    const white = {
      ...base,
      gradient: solidGradient('W', [{ location: 0, color: WHITE }]) as unknown as CommandDescriptor['params'],
    };
    await run({ ...white, mode: 'behind' });
    // Half red over white: the red stays on top.
    expect(layer.buffer.getPixel(2, 2)).toEqual([255, 127, 127, 255]);
    expect(layer.buffer.getPixel(10, 5)).toEqual([255, 255, 255, 255]);
    await run({ ...white, mode: 'clear', opacity: 0.5 });
    expect(layer.buffer.getPixel(10, 5)[3]).toBe(128);
  });

  it('dither breaks up banding the same way on every replay; the descriptor replays identically', async () => {
    const one = setup();
    await one.run({ ...base, end: { x: 4000, y: 0 }, dither: true });
    const two = setup();
    await two.run(one.history.descriptorOf(one.history.entries.at(-1)!.id)!.params);
    const row = (env: ReturnType<typeof setup>) =>
      Array.from({ length: 40 }, (_, x) => env.doc.background!.buffer.getPixel(x, 3)[0]);
    expect(row(two)).toEqual(row(one));
    // Without dither the long, nearly flat ramp is a single value; with it, values differ.
    expect(new Set(row(one)).size).toBeGreaterThan(1);
    expect(() => one.run({ ...base, shape: 'spiral' })).toThrow(/shape/);
    expect(() => one.run({ ...base, start: { x: 'a' } })).toThrow(/start/);
  });
});
