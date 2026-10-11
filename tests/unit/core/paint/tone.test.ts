import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../../../../src/core/commands/command';
import { History } from '../../../../src/core/history/history';
import { DEFAULT_BRUSH, POINT_FIELDS, packPoints, strokePoint } from '../../../../src/core/paint/brush';
import { applyTone, parseTone, rangeWeight, toneValue, type ToneSetup } from '../../../../src/core/paint/tone';
import { rgbToHsb } from '../../../../src/core/color/color';
import { createContext, withBackground } from '../helpers';

const dodge = (range: 'shadows' | 'midtones' | 'highlights', protect = true): ToneSetup => ({
  kind: 'dodge',
  range,
  protect,
});
const burn = (range: 'shadows' | 'midtones' | 'highlights', protect = true): ToneSetup => ({
  kind: 'burn',
  range,
  protect,
});
const run = (tone: ToneSetup, c: number[], a = 1) => {
  const out = [...c];
  applyTone(tone, out, c.length, a);
  return out;
};

describe('Dodge and Burn', () => {
  it('ranges touch the shadows, midtones or highlights most', () => {
    expect(rangeWeight('shadows', 0.1)).toBeGreaterThan(rangeWeight('shadows', 0.9));
    expect(rangeWeight('highlights', 0.9)).toBeGreaterThan(rangeWeight('highlights', 0.1));
    expect(rangeWeight('midtones', 0.5)).toBe(1);
    expect(rangeWeight('midtones', 0)).toBe(0);
    expect(rangeWeight('midtones', 1)).toBe(0);
  });

  it('dodge lightens and burn darkens, more with a larger amount, never past white or black', () => {
    expect(toneValue('dodge', 'midtones', 0.5, 1)).toBeGreaterThan(toneValue('dodge', 'midtones', 0.5, 0.5));
    expect(toneValue('dodge', 'midtones', 0.5, 0.5)).toBeGreaterThan(0.5);
    expect(toneValue('burn', 'midtones', 0.5, 1)).toBeLessThan(0.5);
    for (const v of [0, 0.2, 0.5, 0.8, 1]) {
      expect(toneValue('dodge', 'shadows', v, 1)).toBeLessThanOrEqual(1);
      expect(toneValue('burn', 'highlights', v, 1)).toBeGreaterThanOrEqual(0);
    }
    // Midtones leave black and white alone.
    expect(toneValue('dodge', 'midtones', 0, 1)).toBe(0);
    expect(toneValue('burn', 'midtones', 1, 1)).toBe(1);
  });

  it('Protect Tones keeps the hue; without it the channels move apart', () => {
    const orange = [0.8, 0.4, 0.1];
    const hue = (c: number[]) => rgbToHsb({ r: c[0]!, g: c[1]!, b: c[2]! }).h;
    const protectedDodge = run(dodge('midtones'), orange);
    expect(hue(protectedDodge)).toBeCloseTo(hue(orange), 0);
    expect(protectedDodge[1]).toBeGreaterThan(0.4);
    const protectedBurn = run(burn('midtones'), orange);
    expect(hue(protectedBurn)).toBeCloseTo(hue(orange), 0);
    expect(protectedBurn[0]).toBeLessThan(0.8);
    const plain = run(dodge('midtones', false), orange);
    expect(Math.abs(hue(plain) - hue(orange))).toBeGreaterThan(2);
    // Nothing clips: a saturated colour dodged stays below white in its other channels.
    expect(run(dodge('highlights'), [1, 0.2, 0.2]).every((v) => v <= 1)).toBe(true);
  });

  it('reads recorded settings', () => {
    expect(parseTone({ range: 'shadows', protect: false }, 'burn')).toEqual(burn('shadows', false));
    expect(parseTone(undefined, 'dodge')).toEqual(dodge('midtones'));
    expect(() => parseTone({ range: 'everything' }, 'dodge')).toThrow('range');
    expect(parseTone({ saturate: true }, 'sponge')).toEqual({ kind: 'sponge', saturate: true, vibrance: true });
  });
});

describe('Sponge', () => {
  const sponge = (saturate: boolean, vibrance = true): ToneSetup => ({ kind: 'sponge', saturate, vibrance });
  const sat = (c: number[]) => rgbToHsb({ r: c[0]!, g: c[1]!, b: c[2]! }).s;

  it('desaturates and saturates colours', () => {
    const c = [0.7, 0.4, 0.3];
    expect(sat(run(sponge(false), c))).toBeLessThan(sat(c));
    expect(sat(run(sponge(true), c))).toBeGreaterThan(sat(c));
    expect(run(sponge(false), [0.5, 0.5, 0.5])).toEqual([0.5, 0.5, 0.5]);
  });

  it('Vibrance keeps saturated colours from clipping', () => {
    const vivid = [0.9, 0.2, 0.15];
    const plain = run(sponge(true, false), vivid);
    expect(plain[0]).toBe(1); // clipped
    const spared = run(sponge(true, true), vivid);
    expect(spared[0]).toBeLessThanOrEqual(1);
    expect(spared[0]! - vivid[0]!).toBeLessThan(plain[0]! - vivid[0]!);
  });

  it('changes the contrast of grays in Grayscale', () => {
    expect(run(sponge(true), [0.3])[0]).toBeLessThan(0.3);
    expect(run(sponge(true), [0.7])[0]).toBeGreaterThan(0.7);
    expect(run(sponge(false), [0.3])[0]).toBeGreaterThan(0.3);
    expect(run(sponge(false), [0.5])[0]).toBe(0.5);
  });
});

describe('tone strokes', () => {
  const W = 64;
  const H = 32;
  function setup(init: Parameters<typeof createContext>[0] = {}) {
    const env = withBackground(createContext({ width: W, height: H, ...init }));
    const history = new History(env.doc);
    env.ctx.history = history;
    const exec = (name: string, params: CommandDescriptor['params']) =>
      history.execute(env.registry.create(env.ctx, { name, params }));
    return { ...env, history, exec, bg: env.doc.background! };
  }
  const stroke = (tool: string, tone: object, opacity = 0.5, channels = 3) => ({
    tool,
    points: packPoints([strokePoint(10, 16), strokePoint(50, 16)]),
    stride: POINT_FIELDS.length,
    brush: { ...DEFAULT_BRUSH, size: 8, opacity } as never,
    color: new Array<number>(channels).fill(0),
    seed: 1,
    tone: tone as never,
  });

  it('a Dodge stroke lightens up to its exposure, once per stroke; Burn darkens; each is one step', async () => {
    const { bg, exec, history } = setup();
    await exec('fill', { color: [128, 128, 128] });
    await exec('paintStroke', stroke('dodge', { range: 'midtones', protect: true }));
    expect(history.entries.at(-1)!.label).toBe('Dodge Tool');
    const once = bg.buffer.getPixel(30, 16)[0]!;
    expect(once).toBeGreaterThan(128);
    expect(bg.buffer.getPixel(30, 2)).toEqual([128, 128, 128]);
    await exec('paintStroke', stroke('dodge', { range: 'midtones', protect: true }));
    expect(bg.buffer.getPixel(30, 16)[0]).toBeGreaterThan(once); // a second stroke builds on the first
    await exec('paintStroke', stroke('burn', { range: 'midtones', protect: true }, 1));
    expect(history.entries.at(-1)!.label).toBe('Burn Tool');
    expect(bg.buffer.getPixel(30, 16)[0]).toBeLessThan(once + 20);
    await history.undo();
    await history.undo();
    await history.undo();
    expect(bg.buffer.getPixel(30, 16)).toEqual([128, 128, 128]);
  });

  it('a Sponge stroke desaturates, and replays the same (Actions)', async () => {
    const a = setup();
    await a.exec('fill', { color: [200, 80, 40] });
    await a.exec('paintStroke', stroke('sponge', { saturate: false, vibrance: true }, 1));
    expect(a.history.entries.at(-1)!.label).toBe('Sponge Tool');
    const p = a.bg.buffer.getPixel(30, 16);
    expect(p[0]! - p[2]!).toBeLessThan(160);
    const d = JSON.parse(JSON.stringify(a.history.descriptorOf(a.history.entries.at(-1)!.id))) as CommandDescriptor;
    const b = setup();
    await b.exec('fill', { color: [200, 80, 40] });
    await b.exec(d.name, d.params);
    const region = { x: 0, y: 0, w: W, h: H };
    expect(b.bg.buffer.readRegion(region)).toEqual(a.bg.buffer.readRegion(region));
  });

  it('works in 16-bit and Grayscale, and refuses 32-bit images', async () => {
    const deep = setup({ depth: 16 });
    await deep.exec('fill', { color: [30000, 30000, 30000] });
    await deep.exec('paintStroke', stroke('burn', { range: 'midtones' }));
    expect(deep.bg.buffer.getPixel(30, 16)[0]).toBeLessThan(30000);
    const gray = setup({ mode: 'grayscale' });
    await gray.exec('fill', { color: [200] });
    await gray.exec('paintStroke', stroke('sponge', { saturate: true }, 1, 1));
    expect(gray.bg.buffer.getPixel(30, 16)[0]).toBeGreaterThan(200);
    const hdr = setup({ depth: 32 });
    await expect(hdr.exec('paintStroke', stroke('dodge', {}))).rejects.toThrow('32-bit');
  });
});
