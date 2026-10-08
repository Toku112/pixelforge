import { describe, expect, it } from 'vitest';
import type { CommandContext, CommandDescriptor } from '../../../../src/core/commands/command';
import { srgbToLinear } from '../../../../src/core/color/srgb';
import { planFromDocument } from '../../../../src/core/composite/flatten';
import { History } from '../../../../src/core/history/history';
import { DEFAULT_BRUSH, POINT_FIELDS, packPoints, strokePoint } from '../../../../src/core/paint/brush';
import { patternFromImage } from '../../../../src/core/pattern/define-pattern';
import { builtInPattern, patternSamples, type Pattern } from '../../../../src/core/pattern/pattern';
import { readPat, writePat } from '../../../../src/io/pat';
import { DescriptorWriter } from '../../../../src/io/descriptor';
import type { DocumentInit } from '../../../../src/core/document/document';
import { createContext, withBackground } from '../helpers';

/** A 2 × 2 pattern: red, green / blue, half-transparent white. */
const QUAD: Pattern = {
  id: 'quad',
  name: 'Quad',
  width: 2,
  height: 2,
  data: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128),
};

function setup(width = 20, height = 10, init: Partial<DocumentInit> = {}) {
  const env = withBackground(createContext({ width, height, ...init }));
  const ctx: CommandContext = {
    ...env.ctx,
    services: { ...env.ctx.services, patterns: { get: (id) => (id === 'quad' ? QUAD : undefined) } },
  };
  const history = new History(env.doc);
  const run = (name: string, params: CommandDescriptor['params']) =>
    history.execute(env.registry.create(ctx, { name, params }));
  return { ...env, ctx, history, run };
}

describe('patterns', () => {
  it('become document values: RGB, Grayscale (luma) and 32-bit (linear), with alpha', () => {
    const rgb = patternSamples(QUAD, 'rgb', 8);
    expect([...rgb.slice(0, 4)]).toEqual([1, 0, 0, 1]);
    expect(rgb[15]).toBeCloseTo(128 / 255);
    const gray = patternSamples(QUAD, 'grayscale', 8);
    expect(gray[0]).toBeCloseTo(0.299);
    const linear = patternSamples({ ...QUAD, data: Uint8Array.of(128, 128, 128, 255), width: 1, height: 1 }, 'rgb', 32);
    expect(linear[0]).toBeCloseTo(srgbToLinear(128 / 255));
    expect(() => patternSamples(QUAD, 'cmyk', 8)).toThrow(/colour management/);
  });

  it('Edit > Fill with a pattern repeats it from the top left, through the selection; one undoable step', async () => {
    const { doc, history, run } = setup();
    await run('selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 0, y: 0, w: 10, h: 10 } });
    await run('fill', { pattern: 'quad' });
    const bg = doc.background!.buffer;
    expect(bg.getPixel(0, 0)).toEqual([255, 0, 0]);
    expect(bg.getPixel(3, 0)).toEqual([0, 255, 0]);
    expect(bg.getPixel(2, 1)).toEqual([0, 0, 255]);
    expect(bg.getPixel(5, 3)).toEqual([255, 255, 255]); // half-transparent white over white
    expect(bg.getPixel(14, 0)).toEqual([255, 255, 255]); // outside the selection
    expect(history.descriptorOf(history.entries.at(-1)!.id)!.params['pattern']).toBe('quad');
    await history.undo();
    expect(bg.getPixel(0, 0)).toEqual([255, 255, 255]);
    // Built-in patterns are always there; others must be in the library.
    await run('fill', { pattern: 'pf-dots' });
    const dots = builtInPattern('pf-dots')!;
    expect(bg.getPixel(8, 8)).toEqual([...dots.data.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 3)]);
    expect(() => run('fill', { pattern: 7 })).toThrow(/pattern id/);
    await expect(run('fill', { pattern: 'gone' })).rejects.toThrow(/not in the pattern library/);
  });

  it('the Pattern Stamp paints the pattern (aligned to the document, or from the stroke start)', async () => {
    const stroke = async (origin: [number, number], impressionist = false) => {
      const env = setup(30, 20);
      const layer = env.doc.createPixelLayer();
      env.doc.insertLayer(layer);
      env.doc.setActiveLayer(layer.id);
      await env.run('paintStroke', {
        tool: 'pattern-stamp',
        points: packPoints([strokePoint(10, 10)]),
        stride: POINT_FIELDS.length,
        brush: { ...DEFAULT_BRUSH, size: 9, hardness: 1 } as never,
        color: [0, 0, 0],
        seed: 1,
        pattern: { id: 'quad', originX: origin[0], originY: origin[1], impressionist },
      });
      expect(env.history.entries.at(-1)!.label).toBe('Pattern Stamp');
      return layer;
    };
    let layer = await stroke([0, 0]);
    expect(layer.buffer.getPixel(10, 10)).toEqual([255, 0, 0, 255]);
    expect(layer.buffer.getPixel(11, 10)).toEqual([0, 255, 0, 255]);
    expect(layer.buffer.getPixel(10, 11)).toEqual([0, 0, 255, 255]);
    expect(layer.buffer.getPixel(11, 11)).toEqual([255, 255, 255, 128]); // the pattern's transparency
    expect(layer.buffer.getPixel(1, 1)).toEqual([0, 0, 0, 0]); // outside the dab
    layer = await stroke([1, 0]); // the pattern starts one pixel to the right
    expect(layer.buffer.getPixel(11, 10)).toEqual([255, 0, 0, 255]);
    layer = await stroke([0, 0], true); // Impressionist: the dab is one colour
    expect(layer.buffer.getPixel(11, 11)).toEqual(layer.buffer.getPixel(9, 9));
  });

  it('fills and stamps in 16-bit and Grayscale documents', async () => {
    const deep = setup(20, 10, { depth: 16 });
    await deep.run('fill', { pattern: 'quad' });
    expect(deep.doc.background!.buffer.getPixel(1, 0)).toEqual([0, 65535, 0]);
    const layer = deep.doc.createPixelLayer();
    deep.doc.insertLayer(layer);
    deep.doc.setActiveLayer(layer.id);
    await deep.run('paintStroke', {
      tool: 'pattern-stamp',
      points: packPoints([strokePoint(10, 5)]),
      stride: POINT_FIELDS.length,
      brush: { ...DEFAULT_BRUSH, size: 5, hardness: 1 } as never,
      color: [0, 0, 0],
      seed: 1,
      pattern: { id: 'quad', originX: 0, originY: 0, impressionist: false },
    });
    expect(layer.buffer.getPixel(10, 5)).toEqual([0, 0, 65535, 65535]);
    const gray = setup(20, 10, { mode: 'grayscale' });
    await gray.run('fill', { pattern: 'quad' });
    expect(gray.doc.background!.buffer.getPixel(0, 0)).toEqual([76]); // red's luma
  });

  it('Define Pattern takes the visible image in the rectangle and checks the selection is a sharp rectangle', async () => {
    const { doc, run } = setup();
    await run('fill', { color: [10, 20, 30] });
    const plan = planFromDocument(doc);
    const plain = patternFromImage(plan, { x: 2, y: 2, w: 3, h: 2 }, null, doc.canvasRect);
    expect(plain.rectangular).toBe(true);
    expect([...plain.data.slice(0, 4)]).toEqual([10, 20, 30, 255]);
    expect(plain.data.length).toBe(3 * 2 * 4);
    await run('selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 2, y: 2, w: 3, h: 2 } });
    expect(patternFromImage(plan, { x: 2, y: 2, w: 3, h: 2 }, doc.selection!.data, doc.canvasRect).rectangular).toBe(
      true,
    );
    await run('selectShape', { tool: 'elliptical-marquee', shape: { kind: 'ellipse', x: 2, y: 2, w: 6, h: 6 } });
    expect(patternFromImage(plan, { x: 2, y: 2, w: 6, h: 6 }, doc.selection!.data, doc.canvasRect).rectangular).toBe(
      false,
    );
  });
});

describe('pattern files (.pat)', () => {
  it('round-trip our patterns, keeping transparency', () => {
    const dots = builtInPattern('pf-dots')!;
    const { patterns, notes } = readPat(writePat([QUAD, dots]));
    expect(notes).toEqual([]);
    expect(patterns.map((p) => [p.name, p.width, p.height])).toEqual([
      ['Quad', 2, 2],
      ['Dots', 16, 16],
    ]);
    expect(patterns[0]!.data).toEqual(QUAD.data);
    expect(patterns[1]!.data).toEqual(dots.data);
  });

  /** A one-pattern file in a given mode, channels given as planes (RLE-compressed when asked). */
  function patFile(
    mode: number,
    w: number,
    h: number,
    planes: number[][],
    opts: { rle?: boolean; depth?: 8 | 16; palette?: number[] } = {},
  ) {
    const depth = opts.depth ?? 8;
    const out = new DescriptorWriter().ascii('8BPT').u16(1).u32(1);
    out.u32(1).u32(mode).u16(h).u16(w).unicode('Made').u8(2).ascii('id');
    if (opts.palette) out.bytes(Uint8Array.from(opts.palette)).u32(0);
    const body = new DescriptorWriter();
    body.u32(0).u32(0).u32(h).u32(w).u32(planes.length);
    for (const plane of planes) {
      let data: number[];
      if (opts.rle) {
        // Each row as one literal run: count byte, then the row.
        const rows: number[][] = [];
        for (let y = 0; y < h; y++) rows.push([w - 1, ...plane.slice(y * w, y * w + w)]);
        data = [...rows.flatMap((r) => [(r.length >> 8) & 255, r.length & 255]), ...rows.flat()];
      } else if (depth === 16) data = plane.flatMap((v) => [v, 0]);
      else data = plane;
      body
        .u32(1)
        .u32(23 + data.length)
        .u32(depth)
        .u32(0)
        .u32(0)
        .u32(h)
        .u32(w)
        .u16(depth)
        .u8(opts.rle ? 1 : 0);
      body.bytes(Uint8Array.from(data));
    }
    body.u32(0).u32(0); // user and sheet masks: not written
    const list = body.result();
    out.u32(3).u32(list.length).bytes(list);
    return out.result();
  }

  it('read Grayscale (RLE), Indexed, 16-bit and CMYK patterns', () => {
    const gray = readPat(patFile(1, 2, 2, [[0, 64, 128, 255]], { rle: true })).patterns[0]!;
    expect([...gray.data]).toEqual([0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
    const palette = new Array<number>(768).fill(0);
    palette.splice(3, 3, 10, 20, 30);
    const indexed = readPat(patFile(2, 1, 1, [[1]], { palette })).patterns[0]!;
    expect([...indexed.data]).toEqual([10, 20, 30, 255]);
    const deep = readPat(patFile(3, 1, 1, [[200], [100], [50]], { depth: 16 })).patterns[0]!;
    expect([...deep.data]).toEqual([200, 100, 50, 255]);
    const cmyk = readPat(patFile(4, 1, 1, [[0], [255], [255], [255]]));
    expect([...cmyk.patterns[0]!.data]).toEqual([0, 255, 255, 255]); // full cyan
    expect(cmyk.notes).toHaveLength(1);
    expect(() => readPat(patFile(0, 1, 1, [[0]]))).toThrow(/Bitmap/);
    expect(() => readPat(new TextEncoder().encode('8BPS0000000000'))).toThrow(/not a pattern file/);
  });
});
