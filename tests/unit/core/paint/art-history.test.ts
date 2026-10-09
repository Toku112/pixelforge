import { describe, expect, it } from 'vitest';
import {
  ART_HISTORY_STYLES,
  ArtHistoryDabber,
  type ArtHistoryOptions,
  type ArtHistorySampler,
  type PixelReader,
} from '../../../../src/core/paint/art-history';
import { DEFAULT_BRUSH, POINT_FIELDS, packPoints, strokePoint, type Dab } from '../../../../src/core/paint/brush';
import type { CommandDescriptor } from '../../../../src/core/commands/command';
import { History } from '../../../../src/core/history/history';
import { createContext, withBackground } from '../helpers';

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

/** Reads a colour function as an opaque image. */
const opaque =
  (color: (x: number, y: number) => number[]): PixelReader =>
  (x, y, out) => {
    const c = color(Math.floor(x), Math.floor(y));
    for (let i = 0; i < 3; i++) out[i] = c[i]!;
    return 1;
  };

/** Source: red left of x = 50, blue to the right; the layer: white. */
const halves: ArtHistorySampler = {
  source: opaque((x) => (x < 50 ? RED : BLUE)),
  layer: opaque(() => [255, 255, 255]),
  channels: 3,
  max: 255,
};

const brush = { ...DEFAULT_BRUSH, size: 4, hardness: 1 };

function dabs(options: Partial<ArtHistoryOptions>, seed = 1, sampler = halves, points = [strokePoint(25, 25)]): Dab[] {
  const dabber = new ArtHistoryDabber(
    brush,
    { style: 'tight-short', area: 20, tolerance: 0, ...options },
    seed,
    sampler,
  );
  return points.flatMap((p) => dabber.add(p));
}

describe('Art History Brush strokes', () => {
  it('are the same for the same seed and pointer samples, different for another seed', () => {
    const points = [strokePoint(20, 20), strokePoint(30, 22, 1, 10), strokePoint(30, 22, 1, 80)];
    const a = dabs({}, 5, halves, points);
    expect(dabs({}, 5, halves, points)).toEqual(a);
    expect(dabs({}, 6, halves, points)).not.toEqual(a);
    expect(a.length).toBeGreaterThan(0);
  });

  it('take their colours from the source where they start, within Area', () => {
    const left = dabs({ style: 'dab', area: 20 }, 1, halves, [strokePoint(20, 25)]);
    expect(left.length).toBeGreaterThan(1);
    for (const d of left) {
      expect(Math.hypot(d.x - 20, d.y - 25)).toBeLessThanOrEqual(10);
      expect(d.color).toEqual(RED);
    }
    for (const d of dabs({ style: 'dab' }, 1, halves, [strokePoint(80, 25)])) expect(d.color).toEqual(BLUE);
  });

  it('keep painting while the pointer rests, and wait for it to move a little otherwise', () => {
    expect(dabs({}, 1, halves, [strokePoint(25, 25), strokePoint(25.5, 25, 1, 10)]).length).toBe(
      dabs({}, 1, halves, [strokePoint(25, 25)]).length,
    );
    expect(dabs({}, 1, halves, [strokePoint(25, 25), strokePoint(25, 25, 1, 60)]).length).toBeGreaterThan(
      dabs({}, 1, halves, [strokePoint(25, 25)]).length,
    );
  });

  it('skip a transparent source', () => {
    const clear: ArtHistorySampler = { ...halves, source: () => 0 };
    expect(dabs({}, 1, clear)).toEqual([]);
  });

  it('keep to where the layer differs from the source by Tolerance', () => {
    const same: ArtHistorySampler = { ...halves, layer: halves.source };
    expect(dabs({ tolerance: 0.5 }, 1, same)).toEqual([]);
    expect(dabs({ tolerance: 0 }, 1, same).length).toBeGreaterThan(0);
    expect(dabs({ tolerance: 0.5 }).length).toBeGreaterThan(0); // white vs red: very different
  });

  it('run along the source’s edges in the tight styles, and are single dabs in Dab style', () => {
    // A vertical edge at x = 50: strokes starting near it run up and down.
    const near = dabs({ style: 'tight-long', area: 4 }, 3, halves, [strokePoint(50, 50)]);
    const xs = near.map((d) => d.x);
    const ys = near.map((d) => d.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(3 * (Math.max(...xs) - Math.min(...xs)));
    // Dab: one dab per stroke, all within the area.
    const dab = dabs({ style: 'dab', area: 0 });
    expect(dab).toHaveLength(1);
    expect([dab[0]!.x, dab[0]!.y]).toEqual([25, 25]);
  });

  it('get longer with the long styles', () => {
    const count = (style: ArtHistoryOptions['style']) => dabs({ style, area: 0 }, 2).length;
    expect(count('tight-long')).toBeGreaterThan(count('tight-short'));
    expect(count('loose-curl-long')).toBeGreaterThan(count('loose-curl'));
    expect(ART_HISTORY_STYLES).toHaveLength(10);
  });
});

describe('Art History Brush stroke command', () => {
  function paint(seed: number) {
    const env = withBackground(createContext({ width: 80, height: 40 }));
    const doc = env.doc;
    const bg = doc.background!;
    // The source: red and blue halves on the Background.
    const left = new Uint8Array(40 * 40 * 3);
    const right = new Uint8Array(40 * 40 * 3);
    for (let i = 0; i < left.length; i += 3) {
      left.set(RED, i);
      right.set(BLUE, i);
    }
    bg.buffer.writeRegion({ x: 0, y: 0, w: 40, h: 40 }, left);
    bg.buffer.writeRegion({ x: 40, y: 0, w: 40, h: 40 }, right);
    const history = new History(doc);
    env.ctx.history = history;
    const run = (name: string, params: CommandDescriptor['params']) =>
      history.execute(env.registry.create(env.ctx, { name, params }));
    return run('fill', { color: [255, 255, 255] })
      .then(() =>
        run('paintStroke', {
          tool: 'art-history-brush',
          // A sample every 2 px, 10 ms apart, as a pointer gives them.
          points: packPoints(Array.from({ length: 31 }, (_, i) => strokePoint(10 + 2 * i, 20, 1, 10 * i))),
          stride: POINT_FIELDS.length,
          brush: brush as never,
          color: [0, 0, 0],
          seed,
          art: { style: 'tight-medium', area: 12, tolerance: 0 },
        }),
      )
      .then(() => ({ pixels: Array.from(bg.buffer.readRegion({ x: 0, y: 0, w: 80, h: 40 })), history }));
  }

  it('paints the source’s colours, and replays the same', async () => {
    const a = await paint(9);
    expect((await paint(9)).pixels).toEqual(a.pixels);
    expect(a.history.entries.at(-1)!.label).toBe('Art History Brush');
    // On each side the paint shows that side's colour, and only there.
    const side = (x0: number, x1: number) => {
      const out: number[][] = [];
      for (let y = 0; y < 40; y++)
        for (let x = x0; x < x1; x++) out.push(a.pixels.slice((y * 80 + x) * 3, (y * 80 + x) * 3 + 3));
      return out;
    };
    const red = (p: number[]) => p[0]! > 200 && p[1]! < 60 && p[2]! < 60;
    const blue = (p: number[]) => p[2]! > 200 && p[0]! < 60 && p[1]! < 60;
    expect(side(0, 30).filter(red).length).toBeGreaterThan(50);
    expect(side(50, 80).filter(blue).length).toBeGreaterThan(50);
    expect(side(0, 30).some(blue)).toBe(false);
    expect(side(50, 80).some(red)).toBe(false);
  });
});
