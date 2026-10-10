import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '../../../../src/core/base64';
import type { CommandDescriptor } from '../../../../src/core/commands/command';
import { History } from '../../../../src/core/history/history';
import { DEFAULT_BRUSH, POINT_FIELDS, packPoints, strokePoint, type Dab } from '../../../../src/core/paint/brush';
import {
  DEFAULT_MIXER,
  INITIAL_MIXER,
  MIXER_COMBINATIONS,
  MixerRenderer,
  afterStroke,
  decodePaint,
  encodePaint,
  mixerCombination,
  mixerStroke,
  parseMixerStroke,
  runLength,
  sampleMixerLoad,
  solidPaint,
  type MixerStroke,
} from '../../../../src/core/paint/mixer';
import { planFromDocument } from '../../../../src/core/composite/flatten';
import { Selection } from '../../../../src/core/selection/selection';
import { selectShape } from '../../../../src/core/selection/mask-ops';
import { TILE_SIZE } from '../../../../src/core/document/tile';
import { createContext, withBackground } from '../helpers';

const W = 96;
const H = 40;

/** A Background, left half black and right half white, made active; and the History. */
function setup(init: Parameters<typeof createContext>[0] = {}) {
  const env = withBackground(createContext({ width: W, height: H, ...init }));
  const bg = env.doc.background!;
  const max = env.doc.depth === 8 ? 255 : env.doc.depth === 16 ? 65535 : 1;
  const cc = env.doc.colorChannels;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W / 2; x++) bg.buffer.writeRegion({ x, y, w: 1, h: 1 }, pixel(env.doc.depth, cc, 0));
  const history = new History(env.doc);
  env.ctx.history = history;
  const run = (name: string, params: CommandDescriptor['params']) =>
    history.execute(env.registry.create(env.ctx, { name, params }));
  return { ...env, bg, history, run, max };
}

function pixel(depth: 8 | 16 | 32, cc: number, v: number) {
  const values = new Array<number>(cc).fill(v);
  return depth === 8 ? Uint8Array.from(values) : depth === 16 ? Uint16Array.from(values) : Float32Array.from(values);
}

const brush = { ...DEFAULT_BRUSH, size: 10, hardness: 1, spacing: 0.1 };

function mixer(extra: Partial<MixerStroke> = {}): MixerStroke {
  return {
    wet: 1,
    load: 0.5,
    mix: 0.5,
    sampleAllLayers: false,
    reservoir: null,
    level: 0,
    pickup: null,
    ...extra,
  };
}

const red = solidPaint([1, 0, 0], 'u16');

/** A Mixer Brush stroke along y = 20 from x0 to x1 (`channels`: the document's colour channels). */
function stroke(m: MixerStroke, x0 = 30, x1 = 70, channels = 3) {
  return {
    tool: 'mixer-brush',
    points: packPoints([strokePoint(x0, 20), strokePoint(x1, 20)]),
    stride: POINT_FIELDS.length,
    brush: brush as never,
    color: new Array<number>(channels).fill(0),
    seed: 5,
    mixer: m as never,
  };
}

describe('Mixer Brush paint', () => {
  it('base64 matches the standard encoding', () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37) % 256);
    for (const n of [0, 1, 2, 3, 4, 5, 1000]) {
      const part = bytes.subarray(0, n);
      const text = bytesToBase64(part);
      expect(text).toBe(Buffer.from(part).toString('base64'));
      expect(base64ToBytes(text)).toEqual(part);
    }
  });

  it('encodes paint as 16-bit or float samples', () => {
    const picture = { width: 2, height: 1, channels: 2, data: Float32Array.from([0.25, 0.5, 2.5, 1]) };
    const f = decodePaint(encodePaint(picture, 'f32'));
    expect(Array.from(f.data)).toEqual([0.25, 0.5, 2.5, 1]);
    const u = decodePaint(encodePaint(picture, 'u16'));
    expect(u.data[0]).toBeCloseTo(0.25, 4);
    expect(u.data[2]).toBe(1); // clamped
  });

  it('names the useful combinations, and Custom for others', () => {
    expect(MIXER_COMBINATIONS.map((c) => c.label)).toContain('Very Wet, Heavy Mix');
    expect(MIXER_COMBINATIONS).toHaveLength(18);
    expect(mixerCombination({ wet: 1, load: 0.5, mix: 1 })).toBe('very-wet-heavy-mix');
    expect(mixerCombination({ wet: 0, load: 0.5, mix: 0.7 })).toBe('dry'); // Mix does not apply when dry
    expect(mixerCombination({ wet: 0.33, load: 0.5, mix: 0.5 })).toBe('custom');
  });

  it('runs dry sooner with less load', () => {
    expect(runLength(0.05)).toBeLessThan(runLength(0.5));
    expect(runLength(1)).toBe(Infinity);
  });

  it('dry: paints the reservoir colour like a brush, and nothing when empty', async () => {
    const { bg, run } = setup();
    await run('paintStroke', stroke(mixer({ wet: 0, load: 1, reservoir: red, level: 1 })));
    expect(bg.buffer.getPixel(35, 20)).toEqual([255, 0, 0]);
    expect(bg.buffer.getPixel(65, 20)).toEqual([255, 0, 0]);
    expect(bg.buffer.getPixel(65, 30)).toEqual([255, 255, 255]);
    const empty = setup();
    await empty.run('paintStroke', stroke(mixer({ wet: 0, reservoir: null, level: 0 })));
    expect(empty.bg.buffer.getPixel(35, 20)).toEqual([0, 0, 0]);
    expect(empty.bg.buffer.getPixel(65, 20)).toEqual([255, 255, 255]);
  });

  it('dry with a light load: the stroke fades as the reservoir runs out', async () => {
    const { bg, run } = setup();
    await run('paintStroke', stroke(mixer({ wet: 0, load: 0.05, reservoir: red, level: 1 }), 52, 92));
    const near = bg.buffer.getPixel(54, 20);
    const far = bg.buffer.getPixel(85, 20);
    expect(near[1]).toBeLessThan(60); // red near the start
    expect(far[1]).toBeGreaterThan(150); // mostly the white ground further on
  });

  it('wet with a clean brush: drags the canvas colours along the stroke', async () => {
    const { bg, run } = setup();
    await run('paintStroke', stroke(mixer({ wet: 1 }), 30, 70));
    // Black dragged into the white half, past the edge at x = 48.
    expect(bg.buffer.getPixel(56, 20)[0]).toBeLessThan(200);
    // Outside the stroke nothing changed.
    expect(bg.buffer.getPixel(56, 34)).toEqual([255, 255, 255]);
    const dry = setup();
    await dry.run('paintStroke', stroke(mixer({ wet: 0 }), 30, 70));
    expect(dry.bg.buffer.getPixel(56, 20)).toEqual([255, 255, 255]);
  });

  it('Mix 100 %: all the paint comes from the canvas', async () => {
    const { bg, run } = setup();
    await run('paintStroke', stroke(mixer({ wet: 1, mix: 1, reservoir: red, level: 1 }), 60, 90));
    const p = bg.buffer.getPixel(75, 20);
    expect(p).toEqual([255, 255, 255]);
    const half = setup();
    await half.run('paintStroke', stroke(mixer({ wet: 1, mix: 0.5, reservoir: red, level: 1 }), 60, 90));
    const q = half.bg.buffer.getPixel(75, 20);
    expect(q[0]).toBe(255);
    expect(q[1]).toBeLessThan(250); // reddish
  });

  it('wet paint mixes the reservoir colour with the canvas even at Mix 0 %', async () => {
    const { bg, run } = setup();
    await run('paintStroke', stroke(mixer({ wet: 1, mix: 0, load: 1, reservoir: red, level: 1 }), 60, 61));
    const p = bg.buffer.getPixel(60, 20);
    expect(p[0]).toBe(255);
    expect(p[1]).toBeGreaterThan(60); // not pure red: mixed with the white under it
    expect(p[1]).toBeLessThan(200);
  });

  it('stays inside the selection, and keeps locked transparency', async () => {
    const { doc, bg, run } = setup();
    doc.setSelection(
      new Selection(selectShape(null, { kind: 'rect', x: 0, y: 0, w: 60, h: H }, 'new', 0, false, doc.canvasRect)!),
    );
    await run('paintStroke', stroke(mixer({ wet: 0, load: 1, reservoir: red, level: 1 }), 50, 80));
    expect(bg.buffer.getPixel(55, 20)).toEqual([255, 0, 0]);
    expect(bg.buffer.getPixel(70, 20)).toEqual([255, 255, 255]);

    const locked = setup();
    const layer = locked.doc.createPixelLayer();
    locked.doc.insertLayer(layer);
    locked.doc.setActiveLayer(layer.id);
    layer.buffer.writeRegion({ x: 40, y: 15, w: 30, h: 10 }, new Uint8Array(30 * 10 * 4).fill(255));
    layer.locks = { ...layer.locks, transparency: true };
    await locked.run('paintStroke', stroke(mixer({ wet: 0, load: 1, reservoir: red, level: 1 }), 30, 80));
    expect(layer.buffer.getPixel(50, 20)).toEqual([255, 0, 0, 255]);
    expect(layer.buffer.getPixel(34, 20)[3]).toBe(0);
  });

  it('Sample All Layers: takes up what all layers show, painting on the active layer only', async () => {
    const { doc, bg, run } = setup();
    const layer = doc.createPixelLayer();
    doc.insertLayer(layer);
    doc.setActiveLayer(layer.id);
    const before = bg.buffer.readRegion({ x: 0, y: 0, w: W, h: H });
    await run('paintStroke', stroke(mixer({ wet: 1, sampleAllLayers: true }), 30, 70));
    // The black dragged into the white half lands on the empty layer.
    const p = layer.buffer.getPixel(56, 20);
    expect(p[3]).toBeGreaterThan(0);
    expect(p[0]).toBeLessThan(200);
    expect(bg.buffer.readRegion({ x: 0, y: 0, w: W, h: H })).toEqual(before);
    // Without it the empty layer has nothing to take up.
    const alone = setup();
    const empty = alone.doc.createPixelLayer();
    alone.doc.insertLayer(empty);
    alone.doc.setActiveLayer(empty.id);
    await alone.run('paintStroke', stroke(mixer({ wet: 1 }), 30, 70));
    expect(empty.buffer.getPixel(56, 20)[3]).toBe(0);
  });

  it('works in 16-bit and 32-bit documents and in Grayscale', async () => {
    for (const init of [{ depth: 16 as const }, { depth: 32 as const }, { mode: 'grayscale' as const }]) {
      const { bg, run, max, doc } = setup(init);
      const reservoir = solidPaint(new Array<number>(doc.colorChannels).fill(0.5), doc.depth === 32 ? 'f32' : 'u16');
      const cc = doc.colorChannels;
      await run('paintStroke', stroke(mixer({ wet: 0, load: 1, reservoir, level: 1 }), 60, 80, cc));
      expect(bg.buffer.getPixel(70, 20)[0]).toBeCloseTo(0.5 * max, doc.depth === 32 ? 4 : -1);
      await run('paintStroke', stroke(mixer({ wet: 1 }), 30, 70, cc));
      expect(bg.buffer.getPixel(52, 20)[0]).toBeLessThan(0.45 * max);
    }
  });

  it('replays recorded strokes the same, and undoes as one step', async () => {
    const a = setup();
    await a.run('paintStroke', stroke(mixer({ wet: 0.6, mix: 0.4, reservoir: red, level: 0.8 }), 20, 80));
    expect(a.history.entries.at(-1)!.label).toBe('Mixer Brush');
    const json = JSON.stringify(a.history.descriptorOf(a.history.entries.at(-1)!.id));
    const b = setup();
    const d = JSON.parse(json) as CommandDescriptor;
    await b.run(d.name, d.params);
    const region = { x: 0, y: 0, w: W, h: H };
    expect(b.bg.buffer.readRegion(region)).toEqual(a.bg.buffer.readRegion(region));
    await a.history.undo();
    expect(a.bg.buffer.getPixel(60, 20)).toEqual([255, 255, 255]);
  });

  it('refuses recorded paint that does not fit the document', () => {
    expect(() => parseMixerStroke({ reservoir: solidPaint([1], 'u16') }, 3)).toThrow('does not fit');
    expect(() => parseMixerStroke({ wet: 2 }, 3)).toThrow('wet must be');
    expect(parseMixerStroke(undefined, 3)).toMatchObject({ wet: DEFAULT_MIXER.wet, reservoir: null });
  });
});

describe('MixerRenderer', () => {
  const format = { depth: 8 as const, colorChannels: 3, hasAlpha: false };
  /** A tile: black on the left half, white on the right. */
  const tile = () => {
    const t = new Uint8Array(TILE_SIZE * TILE_SIZE * 3);
    for (let y = 0; y < TILE_SIZE; y++)
      for (let x = TILE_SIZE / 2; x < TILE_SIZE; x++) t.fill(255, (y * TILE_SIZE + x) * 3, (y * TILE_SIZE + x + 1) * 3);
    return t;
  };
  const setupOf = (m: MixerStroke) => ({
    format,
    color: [0, 0, 0],
    erase: false,
    opacity: 1,
    flow: 1,
    hardness: 1,
    mode: 'normal' as const,
    tip: null,
    lockAlpha: false,
    offsetX: 0,
    offsetY: 0,
    selection: null,
    mixer: { ...m, side: 15, spacing: 0.1, below: null, layerOpacity: 1 },
  });
  const line = (x0: number, x1: number, y: number, extra: Partial<Dab> = {}): Dab[] =>
    Array.from({ length: x1 - x0 + 1 }, (_, i) => ({
      x: x0 + i,
      y,
      size: 10,
      strength: 1,
      angle: 0,
      roundness: 1,
      flipX: false,
      flipY: false,
      ...extra,
    }));

  it('paints the same in batches as at once', () => {
    const m = mixer({ wet: 0.7, mix: 0.3, reservoir: red, level: 1 });
    const one = tile();
    const r1 = new MixerRenderer(setupOf(m));
    r1.addTile(0, 0, one);
    r1.applyDabs(line(100, 160, 50));
    const two = tile();
    const r2 = new MixerRenderer(setupOf(m));
    r2.addTile(0, 0, two);
    const dabs = line(100, 160, 50);
    for (let i = 0; i < dabs.length; i += 7) r2.applyDabs(dabs.slice(i, i + 7));
    expect(two).toEqual(one);
    expect(r2.mixerEnd()).toEqual(r1.mixerEnd());
  });

  it('keeps a brush per symmetry copy', () => {
    // The mirror image paints white ground only: it must not bring the original's black along.
    const r = new MixerRenderer(setupOf(mixer({ wet: 1 })));
    const t = tile();
    r.addTile(0, 0, t);
    const dabs = line(110, 140, 50).flatMap((d) => [d, { ...d, y: 200, x: d.x + 60, copy: 1 }]);
    r.applyDabs(dabs);
    expect(t[(50 * TILE_SIZE + 135) * 3]).toBeLessThan(200); // the original drags black right
    expect(t[(200 * TILE_SIZE + 195) * 3]).toBe(255); // its copy, all on white, stays white
  });

  it('hands on what the brush holds, which a dirty next stroke paints with', () => {
    const r = new MixerRenderer(setupOf(mixer({ wet: 1 })));
    r.addTile(0, 0, tile());
    r.applyDabs(line(100, 125, 50));
    const end = r.mixerEnd();
    expect(end.pickup).not.toBeNull();
    // On plain white, the held black shows at the start of the next stroke.
    const white = new Uint8Array(TILE_SIZE * TILE_SIZE * 3).fill(255);
    const next = new MixerRenderer(setupOf(mixer({ wet: 1, pickup: end.pickup })));
    next.addTile(0, 0, white);
    next.applyDabs(line(200, 210, 100));
    expect(white[(100 * TILE_SIZE + 201) * 3]).toBeLessThan(250);
  });
});

describe('Mixer Brush state', () => {
  it('starts from the foreground colour, or paint from an image of the same mode', () => {
    const doc = { mode: 'rgb' as const, colorChannels: 3, depth: 8 as const };
    const s = mixerStroke(INITIAL_MIXER, DEFAULT_MIXER, doc, [0, 0, 1]);
    expect(Array.from(decodePaint(s.reservoir!).data)).toEqual([0, 0, 1, 1]);
    const sample = { kind: 'sample' as const, mode: 'grayscale' as const, paint: solidPaint([0.5], 'u16') };
    const fallback = mixerStroke(
      { ...INITIAL_MIXER, load: { ...sample, preview: { width: 1, height: 1, rgba: new Uint8Array(4) } } },
      DEFAULT_MIXER,
      doc,
      [0, 1, 0],
    );
    expect(Array.from(decodePaint(fallback.reservoir!).data)).toEqual([0, 1, 0, 1]);
    expect(mixerStroke({ ...INITIAL_MIXER, level: 0 }, DEFAULT_MIXER, doc, [0, 0, 1]).reservoir).toBeNull();
  });

  it('cleans and loads after each stroke as asked', () => {
    const end = { level: 0.3, pickup: solidPaint([0, 0, 0], 'u16') };
    const both = afterStroke(INITIAL_MIXER, end, 'rgb', { loadAfterStroke: true, cleanAfterStroke: true });
    expect(both).toMatchObject({ level: 1, pickup: null });
    const neither = afterStroke(INITIAL_MIXER, end, 'rgb', { loadAfterStroke: false, cleanAfterStroke: false });
    expect(neither.level).toBe(0.3);
    expect(neither.pickup?.paint).toBe(end.pickup);
    const clean = afterStroke(INITIAL_MIXER, end, 'rgb', { loadAfterStroke: false, cleanAfterStroke: true });
    expect(clean).toMatchObject({ level: 0, pickup: null });
  });

  it('loads paint from the image under the tip, or its average colour', () => {
    const { doc } = setup();
    const plan = planFromDocument(doc);
    const image = sampleMixerLoad(plan, { x: 40, y: 10, w: 16, h: 16 }, doc.canvasRect, false);
    const p = decodePaint(image.paint);
    expect(p.width).toBe(16);
    expect(p.data[0]).toBe(0); // black on the left
    expect(p.data[(16 - 1) * 4]).toBe(1); // white on the right
    const solid = decodePaint(sampleMixerLoad(plan, { x: 40, y: 10, w: 16, h: 16 }, doc.canvasRect, true).paint);
    expect(solid.width).toBe(1);
    expect(solid.data[0]).toBeCloseTo(0.5, 3);
    // Off the canvas there is no paint.
    const off = decodePaint(sampleMixerLoad(plan, { x: -20, y: 10, w: 16, h: 16 }, doc.canvasRect, false).paint);
    expect(off.data[3]).toBe(0);
  });
});
