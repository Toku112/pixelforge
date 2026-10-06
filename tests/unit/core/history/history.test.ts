import { describe, expect, it } from 'vitest';
import type { Command } from '../../../../src/core/commands/command';
import { History } from '../../../../src/core/history/history';
import { createContext, withBackground } from '../helpers';

/** A command that records calls and optionally waits before finishing. */
function fakeCommand(label: string, log: string[], delayMs = 0, fail = false): Command {
  return {
    label,
    descriptor: { name: 'fake', params: { label } },
    undoBytes: 10,
    async execute() {
      log.push(`start ${label}`);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail) throw new Error(`${label} failed`);
      log.push(`do ${label}`);
    },
    undo: () => log.push(`undo ${label}`),
    redo: () => log.push(`redo ${label}`),
  };
}

function setup(maxStates?: number) {
  const env = withBackground(createContext());
  return { ...env, history: new History(env.doc, { maxStates }) };
}

const labels = (h: History) => h.entries.map((e) => `${e.label}:${e.status}`);

describe('History', () => {
  it('starts with the initial "Open" entry', () => {
    const { history } = setup();
    expect(labels(history)).toEqual(['Open:current']);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it('records, undoes and redoes commands', async () => {
    const { history } = setup();
    const log: string[] = [];
    await history.execute(fakeCommand('A', log));
    await history.execute(fakeCommand('B', log));
    expect(labels(history)).toEqual(['Open:past', 'A:past', 'B:current']);
    await history.undo();
    await history.undo();
    expect(labels(history)).toEqual(['Open:current', 'A:future', 'B:future']);
    await history.undo(); // nothing left: no-op
    await history.redo();
    expect(log).toEqual(['start A', 'do A', 'start B', 'do B', 'undo B', 'undo A', 'redo A']);
    expect(history.undoBytes).toBe(20);
  });

  it('discards undone states when a new command runs', async () => {
    const { history } = setup();
    const log: string[] = [];
    await history.execute(fakeCommand('A', log));
    await history.execute(fakeCommand('B', log));
    await history.undo();
    await history.execute(fakeCommand('C', log));
    expect(labels(history)).toEqual(['Open:past', 'A:past', 'C:current']);
    expect(history.canRedo).toBe(false);
  });

  it('jumps to any entry like clicking the History panel', async () => {
    const { history } = setup();
    const log: string[] = [];
    for (const l of ['A', 'B', 'C']) await history.execute(fakeCommand(l, log));
    log.length = 0;
    await history.goTo(0);
    await history.goTo(2);
    expect(log).toEqual(['undo C', 'undo B', 'undo A', 'redo A', 'redo B']);
    await expect(history.goTo(9)).rejects.toThrow('No history entry');
  });

  it('serialises async commands: an undo issued during a command waits for it', async () => {
    const { history } = setup();
    const log: string[] = [];
    const running = history.execute(fakeCommand('Slow', log, 20));
    expect(history.busy).toBe(true);
    const undone = history.undo();
    await Promise.all([running, undone]);
    expect(log).toEqual(['start Slow', 'do Slow', 'undo Slow']);
    expect(history.busy).toBe(false);
  });

  it('does not record a failing command and keeps working afterwards', async () => {
    const { history } = setup();
    const log: string[] = [];
    await expect(history.execute(fakeCommand('Bad', log, 0, true))).rejects.toThrow('Bad failed');
    expect(labels(history)).toEqual(['Open:current']);
    await history.execute(fakeCommand('Good', log));
    expect(labels(history)).toEqual(['Open:past', 'Good:current']);
  });

  it('toggles between the last two states', async () => {
    const { history } = setup();
    const log: string[] = [];
    await history.execute(fakeCommand('A', log));
    await history.execute(fakeCommand('B', log));
    log.length = 0;
    await history.toggleLastState();
    await history.toggleLastState();
    await history.toggleLastState();
    expect(log).toEqual(['undo B', 'redo B', 'undo B']);
  });

  it('emits a change event after every operation', async () => {
    const { history } = setup();
    let count = 0;
    history.changes.on(() => count++);
    await history.execute(fakeCommand('A', []));
    await history.undo();
    expect(count).toBe(2);
  });
});

describe('History limit and the initial snapshot', () => {
  const invert = { name: 'invert', params: {} };

  it('drops the oldest states beyond the limit, keeping the initial snapshot reachable', async () => {
    const { doc, ctx, registry, history } = setup(2);
    const px = () => doc.background!.buffer.getPixel(0, 0)[0];
    for (let i = 0; i < 3; i++) await history.execute(registry.create(ctx, invert)); // white → black → white → black
    expect(px()).toBe(0);
    expect(history.length).toBe(3); // Open + 2 kept commands
    expect(labels(history)).toEqual(['Open:past', 'Invert:past', 'Invert:current']);

    await history.undo();
    expect(px()).toBe(255);
    expect(history.canUndo).toBe(false); // the state before the oldest kept command is gone

    await history.goTo(0); // snapshot jump
    expect(px()).toBe(255);
    expect(doc.background!.buffer.tileCount).toBe(0); // exactly the opened state

    await history.goTo(2); // back through the anchor
    expect(px()).toBe(0);
    await history.goTo(1);
    expect(px()).toBe(255);
  });

  it('starts a new branch from the initial snapshot', async () => {
    const { doc, ctx, registry, history } = setup(1);
    await history.execute(registry.create(ctx, invert));
    await history.execute(registry.create(ctx, invert));
    await history.goTo(0);
    await history.execute(registry.create(ctx, invert));
    expect(labels(history)).toEqual(['Open:past', 'Invert:current']);
    expect(doc.background!.buffer.getPixel(1, 1)).toEqual([0, 0, 0]);
    await history.undo();
    expect(doc.background!.buffer.getPixel(1, 1)).toEqual([255, 255, 255]);
  });

  it('applies a lowered limit immediately', async () => {
    const { history } = setup();
    for (const l of ['A', 'B', 'C', 'D']) await history.execute(fakeCommand(l, []));
    history.maxStates = 2;
    expect(history.entries.map((e) => e.label)).toEqual(['Open', 'C', 'D']);
  });
});

describe('Descriptor replay (Actions)', () => {
  it('replaying recorded descriptors on a fresh document gives identical pixels', async () => {
    const setupDoc = () => {
      const env = withBackground(createContext());
      const layer = env.doc.createPixelLayer();
      env.doc.insertLayer(layer);
      env.doc.setActiveLayer(layer.id);
      layer.buffer.writeRegion({ x: 5, y: 5, w: 2, h: 2 }, new Uint8Array(16).fill(100));
      return { ...env, layer };
    };

    // Record: run commands through the history and keep their descriptors as JSON.
    const a = setupDoc();
    const history = new History(a.doc);
    const commands = [
      a.registry.create(a.ctx, { name: 'invert', params: {} }),
      a.registry.create(a.ctx, { name: 'setLayerProps', params: { layerId: a.layer.id, props: { opacity: 0.5 } } }),
    ];
    for (const cmd of commands) await history.execute(cmd);
    const json = JSON.stringify(commands.map((c) => c.descriptor));

    // Replay on an identical fresh document.
    const b = setupDoc();
    for (const d of JSON.parse(json) as Parameters<typeof b.registry.create>[1][]) {
      await b.registry.create(b.ctx, d).execute();
    }
    const region = { x: 0, y: 0, w: 300, h: 200 };
    expect(b.layer.buffer.readRegion(region)).toEqual(a.layer.buffer.readRegion(region));
    expect(b.layer.opacity).toBe(a.layer.opacity);
  });
});
