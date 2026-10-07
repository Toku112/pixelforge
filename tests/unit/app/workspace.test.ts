import { describe, expect, it } from 'vitest';
import { Workspace } from '../../../src/app/workspace';
import { CommandCancelledError } from '../../../src/core/commands/command';
import { ImageDocument } from '../../../src/core/document/document';
import { createRegistry, referencePixelOps } from '../core/helpers';

function setup() {
  const workspace = new Workspace({ registry: createRegistry(), services: { pixelOps: referencePixelOps } });
  const doc = new ImageDocument({ width: 100, height: 100 });
  doc.insertLayer(doc.createBackgroundLayer());
  const layer = doc.createPixelLayer();
  doc.insertLayer(layer);
  const session = workspace.add(doc);
  const opacity = (value: number) => ({
    name: 'setLayerProps',
    params: { layerId: layer.id, props: { opacity: value } },
  });
  return { workspace, session, layer, opacity };
}

describe('Workspace live preview', () => {
  it('previews without recording, and the final change is one History step from the original value', async () => {
    const { workspace, session, layer, opacity } = setup();
    await workspace.preview(opacity(0.8));
    await workspace.preview(opacity(0.5));
    expect(layer.opacity).toBe(0.5);
    expect(workspace.previewing).toBe(true);
    expect(session.history.entries.map((e) => e.label)).toEqual(['Open']);
    await workspace.execute(opacity(0.4));
    expect(workspace.previewing).toBe(false);
    expect(layer.opacity).toBe(0.4);
    expect(session.history.entries.map((e) => e.label)).toEqual(['Open', 'Layer Opacity']);
    await session.history.undo();
    expect(layer.opacity).toBe(1);
  });

  it('rapid previews do not interleave (the original value survives)', async () => {
    const { workspace, layer, opacity } = setup();
    void workspace.preview(opacity(0.9));
    void workspace.preview(opacity(0.7));
    await workspace.preview(opacity(0.6));
    expect(layer.opacity).toBe(0.6);
    await workspace.cancelPreview();
    expect(layer.opacity).toBe(1);
  });

  it('cancelling a preview restores the original value', async () => {
    const { workspace, session, layer, opacity } = setup();
    await workspace.preview(opacity(0.2));
    await workspace.cancelPreview();
    expect(layer.opacity).toBe(1);
    expect(session.history.length).toBe(1);
  });
});

describe('Workspace long commands', () => {
  it('shows progress after a short delay and can be cancelled, leaving the document unchanged', async () => {
    let release = () => {};
    let reported: ((f: number) => void) | undefined;
    const slowOps = {
      ...referencePixelOps,
      composite: (...args: Parameters<typeof referencePixelOps.composite>) => {
        const task = args[4];
        reported = (f) => task?.progress(f);
        return new Promise<Awaited<ReturnType<typeof referencePixelOps.composite>>>((resolve, reject) => {
          release = () => (task?.cancelled ? reject(new CommandCancelledError()) : resolve([]));
        });
      },
    };
    const workspace = new Workspace({ registry: createRegistry(), services: { pixelOps: slowOps } });
    const doc = new ImageDocument({ width: 100, height: 100 });
    doc.insertLayer(doc.createBackgroundLayer());
    doc.insertLayer(doc.createPixelLayer());
    const session = workspace.add(doc);
    const run = workspace.execute({ name: 'mergeVisible', params: {} });
    await new Promise((r) => setTimeout(r, 300));
    expect(workspace.running).toBe(true);
    reported?.(0.5);
    expect(workspace.task).toEqual({ label: 'Merge Visible', fraction: 0.5 });
    workspace.cancelTask();
    release();
    await expect(run).rejects.toBeInstanceOf(CommandCancelledError);
    expect(workspace.running).toBe(false);
    expect(workspace.task).toBeNull();
    expect(doc.layerCount).toBe(2);
    expect(session.history.length).toBe(1);
  });
});
