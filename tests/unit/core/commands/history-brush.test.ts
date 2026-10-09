import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../../../../src/core/commands/command';
import { History } from '../../../../src/core/history/history';
import { DEFAULT_BRUSH, POINT_FIELDS, packPoints, strokePoint } from '../../../../src/core/paint/brush';
import { StrokeRenderer } from '../../../../src/core/paint/stroke';
import { TILE_SIZE } from '../../../../src/core/document/tile';
import { createContext, withBackground } from '../helpers';

const W = 64;
const H = 32;

/** A white Background, an empty layer above (active) and the History (its source: the opened state). */
function setup() {
  const env = withBackground(createContext({ width: W, height: H }));
  const layer = env.doc.createPixelLayer();
  env.doc.insertLayer(layer);
  env.doc.setActiveLayer(layer.id);
  const history = new History(env.doc);
  env.ctx.history = history;
  const run = (name: string, params: CommandDescriptor['params']) =>
    history.execute(env.registry.create(env.ctx, { name, params }));
  return { ...env, layer, history, run };
}

const hard = { ...DEFAULT_BRUSH, size: 8, hardness: 1, spacing: 0.1 };

/** A stroke along y = 16 from x = 10 to 50. */
function stroke(tool: string, extra: CommandDescriptor['params'] = {}, brush = hard) {
  return {
    tool,
    points: packPoints([strokePoint(10, 16), strokePoint(50, 16)]),
    stride: POINT_FIELDS.length,
    brush: brush as never,
    color: [0, 0, 0],
    seed: 3,
    ...extra,
  };
}

describe('History Brush', () => {
  it('paints the layer back to the source state, transparency included', async () => {
    const { layer, run, history } = setup();
    await run('fill', { color: [255, 0, 0] });
    await run('paintStroke', stroke('history-brush'));
    expect(layer.buffer.getPixel(30, 16)[3]).toBe(0); // empty when opened
    expect(layer.buffer.getPixel(30, 2)).toEqual([255, 0, 0, 255]);
    expect(history.entries.at(-1)!.label).toBe('History Brush');
    await history.undo();
    expect(layer.buffer.getPixel(30, 16)).toEqual([255, 0, 0, 255]);
  });

  it('paints from the state chosen as the source', async () => {
    const { layer, run, history } = setup();
    await run('fill', { color: [255, 0, 0] });
    await run('fill', { color: [0, 0, 255] });
    await history.setSource(1);
    await run('paintStroke', stroke('history-brush', {}, { ...hard, opacity: 0.5 }));
    expect(layer.buffer.getPixel(30, 16)).toEqual([128, 0, 128, 255]);
    expect(layer.buffer.getPixel(30, 2)).toEqual([0, 0, 255, 255]);
  });

  it('refuses a layer the source state does not have', async () => {
    const { doc, registry, ctx, history } = setup();
    const added = doc.createPixelLayer();
    doc.insertLayer(added);
    doc.setActiveLayer(added.id);
    await expect(
      history.execute(registry.create(ctx, { name: 'paintStroke', params: stroke('history-brush') })),
    ).rejects.toThrow('does not have this layer');
    expect(history.length).toBe(1);
  });

  it('erases to history: back to the source on the Background too', async () => {
    const { doc, layer, run } = setup();
    await run('fill', { color: [255, 0, 0] });
    await run('paintStroke', stroke('eraser', { toHistory: true }));
    expect(layer.buffer.getPixel(30, 16)[3]).toBe(0);
    // A plain erase from the same state would also empty it; on the Background the colour comes back.
    doc.setActiveLayer(doc.background!.id);
    await run('fill', { color: [0, 255, 0] });
    await run('paintStroke', stroke('eraser', { toHistory: true }));
    expect(doc.background!.buffer.getPixel(30, 16)).toEqual([255, 255, 255]);
    expect(doc.background!.buffer.getPixel(30, 2)).toEqual([0, 255, 0]);
  });

  it('replays recorded strokes the same (Actions)', async () => {
    const a = setup();
    await a.run('fill', { color: [255, 0, 0] });
    const params = stroke('history-brush', {}, { ...hard, hardness: 0.3 });
    await a.run('paintStroke', params);
    const json = JSON.stringify(a.history.descriptorOf(a.history.entries.at(-1)!.id));

    const b = setup();
    await b.run('fill', { color: [255, 0, 0] });
    const d = JSON.parse(json) as CommandDescriptor;
    await b.run(d.name, d.params);
    const region = { x: 0, y: 0, w: W, h: H };
    expect(b.layer.buffer.readRegion(region)).toEqual(a.layer.buffer.readRegion(region));
  });

  it('paints the source as colour in other modes', () => {
    const format = { depth: 8 as const, colorChannels: 3, hasAlpha: true };
    const tile = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    for (let i = 0; i < tile.length; i += 4) tile.set([200, 200, 200, 255], i);
    const source = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    for (let i = 0; i < source.length; i += 4) source.set([128, 255, 0, 255], i);
    const renderer = new StrokeRenderer({
      format,
      color: [0, 0, 0],
      erase: false,
      opacity: 1,
      flow: 1,
      hardness: 1,
      mode: 'multiply',
      tip: null,
      lockAlpha: false,
      offsetX: 0,
      offsetY: 0,
      selection: null,
      history: {
        format,
        defaultPixel: [0, 0, 0, 0],
        offsetX: 0,
        offsetY: 0,
        tiles: [{ tx: 0, ty: 0, data: source }],
      },
    });
    renderer.addTile(0, 0, tile);
    renderer.applyDabs([{ x: 20, y: 20, size: 10, strength: 1, angle: 0, roundness: 1, flipX: false, flipY: false }]);
    expect([...tile.subarray((20 * TILE_SIZE + 20) * 4, (20 * TILE_SIZE + 20) * 4 + 4)]).toEqual([100, 200, 0, 255]);
  });
});

describe('History Brush in other modes and depths', () => {
  for (const [label, init, color, white] of [
    ['16-bit RGB', { depth: 16 as const }, [65535, 0, 0], [65535, 65535, 65535]],
    ['8-bit Grayscale', { mode: 'grayscale' as const }, [40], [255]],
    ['32-bit Grayscale', { mode: 'grayscale' as const, depth: 32 as const }, [0.25], [1]],
  ] as const) {
    it(`restores ${label} pixels`, async () => {
      const env = withBackground(createContext({ width: W, height: H, ...init }));
      const history = new History(env.doc);
      env.ctx.history = history;
      const run = (name: string, params: CommandDescriptor['params']) =>
        history.execute(env.registry.create(env.ctx, { name, params }));
      await run('fill', { color: [...color] });
      await run('paintStroke', stroke('history-brush', { color: color.map(() => 0) }));
      const bg = env.doc.background!.buffer;
      expect(bg.getPixel(30, 16)).toEqual([...white]);
      expect(bg.getPixel(30, 2)).toEqual([...color]);
    });
  }
});

describe('Fill > History', () => {
  it('fills the selection with the source state', async () => {
    const { doc, layer, run } = setup();
    await run('fill', { color: [255, 0, 0] });
    await run('selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 0, y: 0, w: 32, h: H } });
    await run('fill', { history: true });
    expect(layer.buffer.getPixel(10, 10)[3]).toBe(0);
    expect(layer.buffer.getPixel(40, 10)).toEqual([255, 0, 0, 255]);
    // Without transparency (the Background) only colours change, towards the source's.
    doc.setActiveLayer(doc.background!.id);
    await run('fill', { color: [0, 0, 0] });
    await run('fill', { history: true, opacity: 0.5 });
    expect(doc.background!.buffer.getPixel(10, 10)).toEqual([128, 128, 128]);
    expect(doc.background!.buffer.getPixel(40, 10)).toEqual([255, 255, 255]); // outside the selection
  });

  it('keeps transparency with Preserve Transparency (a transparent source changes nothing)', async () => {
    const { layer, run } = setup();
    await run('fill', { color: [255, 0, 0] });
    await run('fill', { history: true, preserveTransparency: true });
    expect(layer.buffer.getPixel(10, 10)).toEqual([255, 0, 0, 255]);
  });

  it('blends the source with other modes', async () => {
    const { doc, run, history } = setup();
    doc.setActiveLayer(doc.background!.id);
    await run('fill', { color: [100, 100, 100] });
    await history.setSource(1);
    await run('fill', { color: [200, 200, 200] });
    await run('fill', { history: true, mode: 'multiply' });
    // 200 × 100 / 255.
    expect(doc.background!.buffer.getPixel(5, 5)).toEqual([78, 78, 78]);
  });

  it('needs a source state with the layer', async () => {
    const { doc, registry, ctx, history } = setup();
    const added = doc.createPixelLayer();
    doc.insertLayer(added);
    doc.setActiveLayer(added.id);
    await expect(history.execute(registry.create(ctx, { name: 'fill', params: { history: true } }))).rejects.toThrow(
      'does not have this layer',
    );
  });

  it('records History contents for Actions', async () => {
    const { run, history } = setup();
    await run('fill', { history: true, mode: 'normal', opacity: 1, preserveTransparency: false });
    expect(history.descriptorOf(history.entries.at(-1)!.id)?.params).toMatchObject({ history: true });
  });

  it('fills from where the layer was, in document coordinates, after it moved', async () => {
    const { layer, run, history } = setup();
    await run('selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 0, y: 0, w: 8, h: 8 } });
    await run('fill', { color: [255, 0, 0] });
    await run('deselect', {});
    await history.setSource(3);
    await run('translateLayers', { dx: 300, dy: 0 }); // the red square leaves the canvas
    await run('fill', { history: true });
    expect(layer.offsetX).toBe(300);
    // Where the square was in the document, it is back; elsewhere the layer stays empty.
    expect(layer.buffer.getPixel(4 - 300, 4)).toEqual([255, 0, 0, 255]);
    expect(layer.buffer.getPixel(20 - 300, 4)[3]).toBe(0);
  });
});
