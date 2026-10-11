import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../../../../src/core/commands/command';
import { History } from '../../../../src/core/history/history';
import { DEFAULT_BRUSH, POINT_FIELDS, packPoints, strokePoint } from '../../../../src/core/paint/brush';
import { blurRadius, parseRetouch, retouchModes } from '../../../../src/core/paint/retouch';
import { selectShape } from '../../../../src/core/selection/mask-ops';
import { Selection } from '../../../../src/core/selection/selection';
import { createContext, withBackground } from '../helpers';

const W = 96;
const H = 40;

/** A Background: left half dark, right half light, with a little noise (seeded); and the History. */
function setup(init: Parameters<typeof createContext>[0] = {}) {
  const env = withBackground(createContext({ width: W, height: H, ...init }));
  const bg = env.doc.background!;
  const depth = env.doc.depth;
  const max = depth === 8 ? 255 : depth === 16 ? 65535 : 1;
  const cc = env.doc.colorChannels;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const data =
    depth === 8
      ? new Uint8Array(W * H * cc)
      : depth === 16
        ? new Uint16Array(W * H * cc)
        : new Float32Array(W * H * cc);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = (x < W / 2 ? 0.25 : 0.75) + (rnd() - 0.5) * 0.12;
      for (let c = 0; c < cc; c++) data[(y * W + x) * cc + c] = depth === 32 ? v : Math.round(v * max);
    }
  bg.buffer.writeRegion({ x: 0, y: 0, w: W, h: H }, data);
  const history = new History(env.doc);
  env.ctx.history = history;
  const run = (name: string, params: CommandDescriptor['params']) =>
    history.execute(env.registry.create(env.ctx, { name, params }));
  /** Standard deviation of channel 0 over a box, and its mean. */
  const stats = (x0: number, x1: number, y0 = 16, y1 = 24) => {
    let s = 0;
    let s2 = 0;
    let n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const v = bg.buffer.getPixel(x, y)[0]! / max;
        s += v;
        s2 += v * v;
        n++;
      }
    return { mean: s / n, sd: Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) };
  };
  return { ...env, bg, history, run, stats, max };
}

const brush = { ...DEFAULT_BRUSH, size: 12, hardness: 0.5, spacing: 0.25 };

function stroke(tool: string, retouch: object, x0 = 6, x1 = 90, channels = 3, spacing = 0.25, color = [0, 0, 0]) {
  return {
    tool,
    points: packPoints([strokePoint(x0, 20), strokePoint(x1, 20)]),
    stride: POINT_FIELDS.length,
    brush: { ...brush, spacing } as never,
    color: color.slice(0, channels),
    seed: 3,
    retouch: retouch as never,
  };
}

describe('Blur and Sharpen', () => {
  it('blur radius grows with the brush', () => {
    expect(blurRadius(10)).toBe(1);
    expect(blurRadius(200)).toBe(5);
    expect(blurRadius(5000)).toBe(6);
  });

  it('Blur smooths noise and softens the edge; more Strength, more blur; one History step', async () => {
    const a = setup();
    const before = a.stats(8, 40);
    await a.run('paintStroke', stroke('blur', { strength: 0.5 }));
    expect(a.history.entries.at(-1)!.label).toBe('Blur Tool');
    const half = a.stats(8, 40);
    expect(half.sd).toBeLessThan(before.sd * 0.7);
    expect(half.mean).toBeCloseTo(before.mean, 2);
    expect(a.stats(8, 40, 0, 6).sd).toBeGreaterThan(before.sd * 0.8); // outside the stroke: unchanged
    const b = setup();
    await b.run('paintStroke', stroke('blur', { strength: 1 }));
    expect(b.stats(8, 40).sd).toBeLessThan(half.sd);
    await a.history.undo();
    expect(a.stats(8, 40).sd).toBeCloseTo(before.sd, 6);
  });

  it('Sharpen raises contrast; Protect Detail brings out less noise', async () => {
    const a = setup();
    const before = a.stats(8, 40);
    await a.run('paintStroke', stroke('sharpen', { strength: 0.5, protectDetail: false }));
    expect(a.history.entries.at(-1)!.label).toBe('Sharpen Tool');
    const plain = a.stats(8, 40);
    expect(plain.sd).toBeGreaterThan(before.sd * 1.5);
    expect(plain.mean).toBeCloseTo(before.mean, 1);
    const b = setup();
    await b.run('paintStroke', stroke('sharpen', { strength: 0.5, protectDetail: true }));
    const kept = b.stats(8, 40);
    expect(kept.sd).toBeGreaterThan(before.sd);
    expect(kept.sd).toBeLessThan(plain.sd);
  });

  it('hardly depends on the brush spacing', async () => {
    const a = setup();
    await a.run('paintStroke', stroke('blur', { strength: 0.5 }, 6, 90, 3, 0.25));
    const b = setup();
    await b.run('paintStroke', stroke('blur', { strength: 0.5 }, 6, 90, 3, 0.1));
    expect(Math.abs(a.stats(8, 40).sd - b.stats(8, 40).sd)).toBeLessThan(0.012);
  });

  it('works in 16-bit, 32-bit and Grayscale', async () => {
    for (const init of [{ depth: 16 as const }, { depth: 32 as const }, { mode: 'grayscale' as const }]) {
      const env = setup(init);
      const before = env.stats(8, 40);
      await env.run('paintStroke', stroke('blur', { strength: 0.8 }, 6, 90, env.doc.colorChannels));
      expect(env.stats(8, 40).sd).toBeLessThan(before.sd);
    }
  });
});

describe('Smudge', () => {
  it('drags the colour where the stroke starts along it, further with more Strength', async () => {
    const a = setup();
    await a.run('paintStroke', stroke('smudge', { strength: 0.5 }, 30, 80));
    expect(a.history.entries.at(-1)!.label).toBe('Smudge Tool');
    const near = a.stats(50, 54).mean;
    expect(near).toBeLessThan(0.7); // the dark half dragged into the light one
    const b = setup();
    await b.run('paintStroke', stroke('smudge', { strength: 0.9 }, 30, 80));
    expect(b.stats(60, 66).mean).toBeLessThan(a.stats(60, 66).mean);
    expect(b.stats(60, 66, 0, 4).mean).toBeGreaterThan(0.7); // outside the stroke: unchanged
  });

  it('Finger Painting starts with the foreground colour', async () => {
    const { run, bg } = setup();
    await run('paintStroke', stroke('smudge', { strength: 0.8, finger: true }, 60, 85, 3, 0.1, [255, 0, 0]));
    const p = bg.buffer.getPixel(62, 20);
    expect(p[0]! - p[1]!).toBeGreaterThan(80); // red
  });

  it('modes limit the change: Darken never lightens, Lighten never darkens', async () => {
    const dark = setup();
    const before = dark.bg.buffer.readRegion({ x: 0, y: 0, w: W, h: H });
    // Dark dragged into light with Darken: the light half darkens, nothing gets lighter.
    await dark.run('paintStroke', stroke('smudge', { strength: 0.9, mode: 'darken' }, 10, 80));
    const after = dark.bg.buffer.readRegion({ x: 0, y: 0, w: W, h: H });
    for (let i = 0; i < after.length; i++) expect(after[i]!).toBeLessThanOrEqual(before[i]!);
    expect(dark.stats(50, 56).mean).toBeLessThan(0.7);
    // With Lighten the same stroke darkens nothing.
    const light = setup();
    await light.run('paintStroke', stroke('smudge', { strength: 0.9, mode: 'lighten' }, 10, 80));
    const lit = light.bg.buffer.readRegion({ x: 0, y: 0, w: W, h: H });
    for (let i = 0; i < lit.length; i++) expect(lit[i]!).toBeGreaterThanOrEqual(before[i]!);
  });

  it('Sample All Layers smudges what the layers show onto an empty layer; the selection limits it', async () => {
    const { doc, run, bg } = setup();
    const layer = doc.createPixelLayer();
    doc.insertLayer(layer);
    doc.setActiveLayer(layer.id);
    const below = bg.buffer.readRegion({ x: 0, y: 0, w: W, h: H });
    await run('paintStroke', stroke('smudge', { strength: 0.9, sampleAllLayers: true }, 30, 80));
    expect(layer.buffer.getPixel(55, 20)[3]).toBeGreaterThan(0);
    expect(layer.buffer.getPixel(55, 20)[0]).toBeLessThan(150);
    expect(bg.buffer.readRegion({ x: 0, y: 0, w: W, h: H })).toEqual(below);
    doc.setSelection(
      new Selection(selectShape(null, { kind: 'rect', x: 0, y: 30, w: W, h: 10 }, 'new', 0, false, doc.canvasRect)!),
    );
    await run('paintStroke', stroke('blur', { strength: 1, sampleAllLayers: true }, 6, 90));
    expect(layer.buffer.getPixel(20, 20)[3]).toBe(0); // outside the selection
  });

  it('works only inside the canvas: nothing beyond the edge is smeared in', async () => {
    // The Background's tiles reach past the canvas, where they are white.
    const smudge = setup();
    await smudge.run('paintStroke', stroke('smudge', { strength: 0.95 }, 1, 40));
    expect(smudge.stats(0, 30).mean).toBeLessThan(0.3);
    const mixer = setup();
    await mixer.run('paintStroke', {
      ...stroke('mixer-brush', {}, 1, 40),
      mixer: { wet: 1, load: 0.5, mix: 1, sampleAllLayers: false, reservoir: null, level: 0, pickup: null },
    });
    expect(mixer.stats(0, 30).mean).toBeLessThan(0.3);
  });

  it('replays recorded strokes the same (Actions)', async () => {
    for (const tool of ['smudge', 'blur', 'sharpen']) {
      const a = setup();
      await a.run('paintStroke', stroke(tool, { strength: 0.7, mode: 'luminosity', protectDetail: true }, 10, 85));
      const d = JSON.parse(JSON.stringify(a.history.descriptorOf(a.history.entries.at(-1)!.id))) as CommandDescriptor;
      const b = setup();
      await b.run(d.name, d.params);
      const region = { x: 0, y: 0, w: W, h: H };
      expect(b.bg.buffer.readRegion(region)).toEqual(a.bg.buffer.readRegion(region));
    }
  });

  it('reads recorded settings, and offers the colour modes only for colour images', () => {
    expect(parseRetouch({ mode: 'darken', strength: 0.3 }, 'smudge')).toEqual({
      mode: 'darken',
      strength: 0.3,
      sampleAllLayers: false,
      finger: false,
    });
    expect(parseRetouch(undefined, 'sharpen')).toMatchObject({ protectDetail: true, strength: 0.5 });
    expect(() => parseRetouch({ mode: 'screen' }, 'blur')).toThrow('mode');
    expect(retouchModes(1).map(([m]) => m)).toEqual(['normal', 'darken', 'lighten']);
    expect(retouchModes(3)).toHaveLength(7);
  });
});
