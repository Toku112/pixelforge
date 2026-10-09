import { describe, expect, it } from 'vitest';
import {
  CommandUnavailableError,
  type CommandContext,
  type CommandDescriptor,
} from '../../../../src/core/commands/command';
import { planFromDocument } from '../../../../src/core/composite/flatten';
import type { DocumentInit, ImageDocument } from '../../../../src/core/document/document';
import { History } from '../../../../src/core/history/history';
import type { Pattern } from '../../../../src/core/pattern/pattern';
import { bucketMask, type BucketOptions } from '../../../../src/core/selection/bucket';
import { Selection, type MaskData } from '../../../../src/core/selection/selection';
import { createContext, withBackground } from '../helpers';

const SHARP: BucketOptions = { tolerance: 32, contiguous: true, antiAlias: false };

/** A white Background with grey values painted in (`rows`: one string per row, digits 0–9 = grey 0, 28, … 255). */
function picture(rows: string[]) {
  const env = withBackground(createContext({ width: rows[0]!.length, height: rows.length }));
  const bg = env.doc.background!.buffer;
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const v = Math.round((Number(ch) / 9) * 255);
      bg.writeRegion({ x, y, w: 1, h: 1 }, Uint8Array.of(v, v, v));
    }),
  );
  return env;
}

/** The mask as rows of characters: '#' full, '+' partial, '.' none. */
function drawn(mask: MaskData | null, doc: ImageDocument): string[] {
  const sel = mask ? new Selection(mask) : null;
  const rows: string[] = [];
  for (let y = 0; y < doc.height; y++) {
    let row = '';
    for (let x = 0; x < doc.width; x++) {
      const v = sel?.value(x, y, doc.canvasRect) ?? 0;
      row += v === 255 ? '#' : v > 0 ? '+' : '.';
    }
    rows.push(row);
  }
  return rows;
}

const fillOf = (doc: ImageDocument, x: number, y: number, options = SHARP, selection: MaskData | null = null) =>
  bucketMask(planFromDocument(doc), { x, y }, options, selection, doc.canvasRect);

describe('the Paint Bucket area', () => {
  const walls = [
    '....0.....', //
    '....0.....',
    '....0000..',
    '.......0..',
    '0000...0..',
  ];

  it('Contiguous fills what joins the click through its four neighbours, stopping at other colours', () => {
    const { doc } = picture(walls);
    expect(drawn(fillOf(doc, 0, 0), doc)).toEqual([
      '####......', //
      '####......',
      '####......',
      '#######...',
      '....###...',
    ]);
    // Not Contiguous: every pixel of that colour.
    expect(drawn(fillOf(doc, 0, 0, { ...SHARP, contiguous: false }), doc)).toEqual([
      '####.#####', //
      '####.#####',
      '####....##',
      '#######.##',
      '....###.##',
    ]);
  });

  it('does not leak through diagonal gaps, and fills round corners and into pockets', () => {
    const { doc } = picture([
      '..0.....', //
      '.0..00..',
      '0..0..0.',
      '...0.0..',
      '...0..0.',
      '....00..',
    ]);
    expect(drawn(fillOf(doc, 0, 0), doc)).toEqual([
      '##......', //
      '#.......',
      '........',
      '........',
      '........',
      '........',
    ]);
    // The pocket inside the ring: its turns are reached from below and from above.
    expect(drawn(fillOf(doc, 4, 2), doc)).toEqual([
      '........', //
      '........',
      '....##..',
      '....#...',
      '....##..',
      '........',
    ]);
  });

  it('matches a plain breadth-first fill on random pictures (the scanline fill misses nothing)', () => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let n = 0; n < 20; n++) {
      const w = 5 + Math.floor(random() * 40);
      const h = 5 + Math.floor(random() * 30);
      const rows = Array.from({ length: h }, () =>
        Array.from({ length: w }, () => (random() < 0.45 ? '0' : '.')).join(''),
      );
      const { doc } = picture(rows);
      const sx = Math.floor(random() * w);
      const sy = Math.floor(random() * h);
      const colour = rows[sy]![sx]!;
      const want = rows.map(() => [...'.'.repeat(w)]);
      const queue = [[sx, sy] as const];
      want[sy]![sx] = '#';
      while (queue.length > 0) {
        const [x, y] = queue.shift()!;
        for (const [nx, ny] of [
          [x + 1, y],
          [x - 1, y],
          [x, y + 1],
          [x, y - 1],
        ] as const) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || want[ny]![nx] === '#' || rows[ny]![nx] !== colour) continue;
          want[ny]![nx] = '#';
          queue.push([nx, ny]);
        }
      }
      expect(drawn(fillOf(doc, sx + 0.5, sy + 0.5), doc)).toEqual(want.map((r) => r.join('')));
    }
  });

  it('Tolerance: the largest channel difference from the clicked colour, 0–255', () => {
    const { doc } = withBackground(createContext({ width: 6, height: 1 }));
    const bg = doc.background!.buffer;
    [255, 250, 240, 223, 222, 255].forEach((v, x) => bg.writeRegion({ x, y: 0, w: 1, h: 1 }, Uint8Array.of(v, 255, v)));
    const at = (tolerance: number) => drawn(fillOf(doc, 0, 0, { ...SHARP, tolerance }), doc)[0];
    expect(at(0)).toBe('#.....');
    expect(at(15)).toBe('###...');
    expect(at(32)).toBe('####..'); // 255 − 223 = 32 is in; 33 is not
    expect(at(33)).toBe('######');
    // Not contiguous, tolerance 0: the last pixel has the clicked colour too.
    expect(drawn(fillOf(doc, 0, 0, { ...SHARP, tolerance: 0, contiguous: false }), doc)[0]).toBe('#....#');
  });

  it('Anti-alias gives the pixels next to the area partial coverage — the closer their colour, the more', () => {
    const { doc } = withBackground(createContext({ width: 5, height: 1 }));
    const bg = doc.background!.buffer;
    [255, 255, 128, 0, 255].forEach((v, x) => bg.writeRegion({ x, y: 0, w: 1, h: 1 }, Uint8Array.of(v, v, v)));
    const mask = new Selection(fillOf(doc, 0, 0, { ...SHARP, antiAlias: true })!);
    const values = [0, 1, 2, 3, 4].map((x) => mask.value(x, 0, doc.canvasRect));
    // Grey 128 is 127 away: 1 − (127 − 32) / (255 − 32) of full coverage.
    expect(values).toEqual([255, 255, Math.round(255 * (1 - 95 / 223)), 0, 0]);
    // Without it the edge is hard.
    expect(drawn(fillOf(doc, 0, 0), doc)[0]).toBe('##...');
  });

  it('compares premultiplied colours: every fully transparent pixel is the same colour', () => {
    const { doc } = createContext({ width: 4, height: 1 });
    const layer = doc.createPixelLayer();
    doc.insertLayer(layer);
    layer.buffer.writeRegion(
      { x: 0, y: 0, w: 4, h: 1 },
      Uint8Array.of(255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 9, 9, 9, 0),
    );
    expect(drawn(fillOf(doc, 0, 0, { ...SHARP, tolerance: 0 }), doc)[0]).toBe('##..');
    expect(drawn(fillOf(doc, 0, 0, { ...SHARP, tolerance: 0, contiguous: false }), doc)[0]).toBe('##.#');
  });

  it('stays inside the selection (feathered values carry over); nothing outside it or the canvas', () => {
    const { doc } = picture(['......', '......']);
    // Selected: the left half, the third column half.
    const data = new Uint8Array(256 * 256);
    for (const y of [0, 1]) {
      data.fill(255, y * 256, y * 256 + 2);
      data[y * 256 + 2] = 128;
    }
    const selection: MaskData = { tiles: [{ tx: 0, ty: 0, data }], fill: 0, offsetX: 0, offsetY: 0 };
    const mask = new Selection(fillOf(doc, 0, 0, SHARP, selection)!);
    expect([0, 1, 2, 3].map((x) => mask.value(x, 1, doc.canvasRect))).toEqual([255, 255, 128, 0]);
    expect(fillOf(doc, 4, 0, SHARP, selection)).toBeNull();
    expect(fillOf(doc, -1, 0)).toBeNull();
    expect(fillOf(doc, 0, 2)).toBeNull();
  });
});

/** A 1 × 1 pattern of pure blue. */
const BLUE: Pattern = { id: 'blue', name: 'Blue', width: 1, height: 1, data: Uint8Array.of(0, 0, 255, 255) };

function setup(init: Partial<DocumentInit> = {}) {
  const env = withBackground(createContext({ width: 10, height: 4, ...init }));
  const ctx: CommandContext = {
    ...env.ctx,
    services: { ...env.ctx.services, patterns: { get: (id) => (id === 'blue' ? BLUE : undefined) } },
  };
  const history = new History(env.doc);
  const run = (params: CommandDescriptor['params'], name = 'paintBucket') =>
    history.execute(env.registry.create(ctx, { name, params }));
  // A black wall down column 5 splits the Background in two.
  env.doc.background!.buffer.writeRegion({ x: 5, y: 0, w: 1, h: 4 }, new Uint8Array(4 * 3));
  return { ...env, ctx, history, run };
}

const red = { point: { x: 1, y: 1 }, color: [255, 0, 0] };

describe('the Paint Bucket command', () => {
  it('fills the clicked area with the colour as one undoable "Paint Bucket" step', async () => {
    const { doc, history, run } = setup();
    await run(red);
    expect(history.entries.at(-1)!.label).toBe('Paint Bucket');
    const bg = doc.background!.buffer;
    expect(bg.getPixel(0, 0)).toEqual([255, 0, 0]);
    expect(bg.getPixel(4, 3)).toEqual([255, 0, 0]);
    expect(bg.getPixel(5, 0)).toEqual([0, 0, 0]);
    expect(bg.getPixel(6, 0)).toEqual([255, 255, 255]);
    await history.undo();
    expect(bg.getPixel(0, 0)).toEqual([255, 255, 255]);
    await history.redo();
    expect(bg.getPixel(0, 0)).toEqual([255, 0, 0]);
  });

  it('replays from its descriptor to the same result (Actions)', async () => {
    const first = setup();
    await first.run({ ...red, tolerance: 10, mode: 'multiply', opacity: 0.5 });
    const descriptor = first.history.descriptorOf(first.history.entries.at(-1)!.id)!;
    const second = setup();
    await second.history.execute(second.registry.create(second.ctx, descriptor));
    const read = (env: ReturnType<typeof setup>) => [...env.doc.background!.buffer.readRegion(env.doc.canvasRect)];
    expect(read(second)).toEqual(read(first));
  });

  it('fills with a pattern, a blend mode and opacity', async () => {
    const { doc, run } = setup();
    await run({ point: { x: 8, y: 2 }, pattern: 'blue' });
    expect(doc.background!.buffer.getPixel(9, 0)).toEqual([0, 0, 255]);
    expect(doc.background!.buffer.getPixel(0, 0)).toEqual([255, 255, 255]);
    await run({ ...red, mode: 'multiply', opacity: 0.5 });
    expect(doc.background!.buffer.getPixel(0, 0)).toEqual([255, 128, 128]);
    await expect(run({ point: { x: 1, y: 1 }, pattern: 'gone' })).rejects.toThrow(/not in the pattern library/);
  });

  it('compares the active layer only (as if opaque), or with All Layers what the image shows', async () => {
    const { doc, run } = setup();
    // An empty layer over the walled Background, at half opacity.
    const layer = doc.createPixelLayer();
    layer.opacity = 0.5;
    doc.insertLayer(layer);
    doc.setActiveLayer(layer.id);
    await run(red);
    // Its own pixels are all transparent: the whole layer fills.
    expect(layer.buffer.getPixel(8, 0)).toEqual([255, 0, 0, 255]);
    expect(doc.background!.buffer.getPixel(0, 0)).toEqual([255, 255, 255]); // only the active layer changes

    const other = doc.createPixelLayer();
    doc.insertLayer(other);
    doc.setActiveLayer(other.id);
    layer.visible = false;
    await run({ ...red, color: [0, 255, 0], allLayers: true });
    expect(other.buffer.getPixel(0, 0)).toEqual([0, 255, 0, 255]);
    expect(other.buffer.getPixel(5, 0)).toEqual([0, 0, 0, 0]); // the wall of the Background
    expect(other.buffer.getPixel(8, 0)).toEqual([0, 0, 0, 0]);
  });

  it('keeps locked transparency; Behind paints under existing pixels and Clear erases', async () => {
    const { doc, run } = setup();
    const layer = doc.createPixelLayer();
    doc.insertLayer(layer);
    doc.setActiveLayer(layer.id);
    layer.buffer.writeRegion({ x: 0, y: 0, w: 2, h: 1 }, Uint8Array.of(0, 0, 255, 128, 0, 0, 255, 128));
    await run({ point: { x: 0, y: 0 }, color: [255, 0, 0], mode: 'behind' });
    // Behind: the red shows only through the half-transparent pixels.
    expect(layer.buffer.getPixel(0, 0)).toEqual([127, 0, 128, 255]);
    await run({ point: { x: 0, y: 0 }, color: [0, 0, 0], mode: 'clear', tolerance: 0 });
    expect(layer.buffer.getPixel(0, 0)[3]).toBe(0);

    layer.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, Uint8Array.of(0, 0, 255, 128));
    layer.locks = { ...layer.locks, transparency: true };
    await run({ point: { x: 9, y: 3 }, color: [0, 255, 0], tolerance: 255 });
    expect(layer.buffer.getPixel(0, 0)).toEqual([0, 255, 0, 128]);
    expect(layer.buffer.getPixel(9, 3)).toEqual([0, 0, 0, 0]);
  });

  it('stays inside the selection; a click outside it does nothing', async () => {
    const { doc, history, run } = setup();
    await run({ tool: 'rectangular-marquee', shape: { kind: 'rect', x: 0, y: 0, w: 2, h: 4 } }, 'selectShape');
    await run(red);
    expect(doc.background!.buffer.getPixel(1, 0)).toEqual([255, 0, 0]);
    expect(doc.background!.buffer.getPixel(2, 0)).toEqual([255, 255, 255]);
    const steps = history.entries.length;
    await expect(run({ ...red, point: { x: 3, y: 1 } })).rejects.toBeInstanceOf(CommandUnavailableError);
    expect(history.entries.length).toBe(steps);
  });

  it('works in 16-bit, 32-bit and Grayscale documents', async () => {
    const cases = [
      ['rgb', 16, [65535, 0, 0], [65535, 0, 0]],
      ['rgb', 32, [1, 0.5, 0], [1, 0.5, 0]],
      ['grayscale', 8, [100], [100]],
    ] as const;
    for (const [mode, depth, color, expected] of cases) {
      const env = withBackground(createContext({ width: 6, height: 2, mode, depth }));
      const history = new History(env.doc);
      await history.execute(
        env.registry.create(env.ctx, { name: 'paintBucket', params: { point: { x: 0, y: 0 }, color: [...color] } }),
      );
      const got = env.doc.background!.buffer.getPixel(5, 1);
      expected.forEach((v, c) => expect(got[c]).toBeCloseTo(v, 4));
    }
  });

  it('checks its parameters', () => {
    const { ctx, registry } = setup();
    const create = (params: CommandDescriptor['params']) => registry.create(ctx, { name: 'paintBucket', params });
    expect(() => create({ color: [0, 0, 0] })).toThrow(/point/);
    expect(() => create({ ...red, tolerance: 300 })).toThrow(/tolerance/);
    expect(() => create({ ...red, mode: 'nope' })).toThrow(/blend mode/);
    expect(() => create({ ...red, contiguous: 1 })).toThrow(/contiguous/);
  });
});
