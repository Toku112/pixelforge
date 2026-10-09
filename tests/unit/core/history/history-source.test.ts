import { describe, expect, it } from 'vitest';
import { History } from '../../../../src/core/history/history';
import { HistorySourceError } from '../../../../src/core/history/history-source';
import { createContext, withBackground } from '../helpers';

const invert = { name: 'invert', params: {} };

function setup(maxStates?: number) {
  const env = withBackground(createContext({ width: 40, height: 20 }));
  const history = new History(env.doc, { maxStates });
  env.ctx.history = history;
  const px = () => env.doc.background!.buffer.getPixel(3, 3)[0];
  const sourcePx = async () => (await history.sourceLayer(env.doc.background!.id)).buffer.getPixel(3, 3)[0];
  return { ...env, history, px, sourcePx };
}

const sources = (h: History) => h.entries.map((e) => (e.source ? 'S' : '-')).join('');

describe('History Brush source', () => {
  it('is the initial snapshot to begin with', async () => {
    const { ctx, registry, history, sourcePx } = setup();
    await history.execute(registry.create(ctx, invert));
    expect(sources(history)).toBe('S-');
    expect(history.sourceIndex).toBe(0);
    expect(await sourcePx()).toBe(255); // the opened (white) state
  });

  it('captures a past state chosen as the source, leaving the document as it is', async () => {
    const { ctx, registry, history, px, sourcePx } = setup();
    for (let i = 0; i < 3; i++) await history.execute(registry.create(ctx, invert)); // black, white, black
    await history.setSource(1);
    expect(sources(history)).toBe('-S--');
    expect(history.currentIndex).toBe(3);
    expect(px()).toBe(0);
    expect(await sourcePx()).toBe(0); // after the first Invert
    await history.setSource(2);
    expect(await sourcePx()).toBe(255);
    await history.setSource(3); // the current state
    expect(await sourcePx()).toBe(0);
  });

  it('can be a state that was undone', async () => {
    const { ctx, registry, history, px, sourcePx } = setup();
    await history.execute(registry.create(ctx, invert));
    await history.undo();
    await history.setSource(1);
    expect(px()).toBe(255);
    expect(await sourcePx()).toBe(0);
    expect(history.currentIndex).toBe(0);
  });

  it('goes back to the initial snapshot when its state is discarded or dropped', async () => {
    const { ctx, registry, history } = setup(3);
    await history.execute(registry.create(ctx, invert));
    await history.execute(registry.create(ctx, invert));
    await history.setSource(2);
    await history.undo();
    await history.execute(registry.create(ctx, invert)); // discards the source state
    expect(sources(history)).toBe('S--');

    await history.setSource(1);
    for (let i = 0; i < 3; i++) await history.execute(registry.create(ctx, invert)); // drops the oldest states
    expect(sources(history)).toBe('S---');
  });

  it('is captured correctly after the oldest states were dropped', async () => {
    const { ctx, registry, history, px, sourcePx } = setup(2);
    for (let i = 0; i < 3; i++) await history.execute(registry.create(ctx, invert)); // black, white, black
    await history.goTo(0); // the snapshot (white)
    await history.setSource(1); // the kept state after the second Invert (white)
    expect(await sourcePx()).toBe(255);
    expect(px()).toBe(255);
    await history.setSource(2);
    expect(await sourcePx()).toBe(0);
    expect(history.currentIndex).toBe(0);
    await history.goTo(2);
    expect(px()).toBe(0);
  });

  it('refuses layers the source state does not have, and a different canvas', async () => {
    const { doc, ctx, registry, history } = setup();
    const layer = doc.createPixelLayer();
    doc.insertLayer(layer);
    await expect(history.sourceLayer(layer.id)).rejects.toThrow(HistorySourceError);
    await expect(history.sourceLayer(layer.id)).rejects.toThrow('does not have this layer');

    await history.execute(
      registry.create(ctx, { name: 'canvasSize', params: { width: 50, height: 20, anchor: [0, 0] } }),
    );
    await history.setSource(1);
    await history.execute(registry.create(ctx, invert));
    await history.setSource(0);
    await expect(history.sourceLayer(doc.background!.id)).rejects.toThrow('canvas size');
    await history.setSource(2);
    await expect(history.sourceLayer(doc.background!.id)).resolves.toBeDefined();
  });
});
