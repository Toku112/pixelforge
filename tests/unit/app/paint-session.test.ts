import { describe, expect, it } from 'vitest';
import { PaintSession } from '../../../src/app/paint-session';
import { Workspace } from '../../../src/app/workspace';
import { ImageDocument } from '../../../src/core/document/document';
import { DEFAULT_BRUSH, strokePoint, type Dab } from '../../../src/core/paint/brush';
import { StrokeRenderer } from '../../../src/core/paint/stroke';
import type { LiveStroke } from '../../../src/workers/stroke-client';
import { createRegistry, referencePixelOps } from '../core/helpers';

function setup() {
  const workspace = new Workspace({ registry: createRegistry(), services: { pixelOps: referencePixelOps } });
  const doc = new ImageDocument({ width: 100, height: 100 });
  const bg = doc.createBackgroundLayer();
  doc.insertLayer(bg);
  doc.setActiveLayer(bg.id);
  const session = workspace.add(doc);
  return { workspace, doc, bg, session };
}

/** A live stroke painted by the TypeScript renderer once `gate` opens (a busy worker). */
function liveStroke(layer: ReturnType<typeof setup>['bg'], color: number[], gate: Promise<void>): LiveStroke {
  const renderer = new StrokeRenderer({
    format: layer.buffer.format,
    color,
    erase: false,
    opacity: 1,
    flow: 1,
    hardness: 1,
    mode: 'normal',
    tip: null,
    lockAlpha: false,
    offsetX: 0,
    offsetY: 0,
    selection: null,
  });
  return {
    async paint(tiles, dabs) {
      await gate;
      for (const t of tiles) renderer.addTile(t.tx, t.ty, t.data);
      renderer.applyDabs(dabs);
    },
    mixerEnd: () => Promise.resolve(null),
    end: () => {},
  };
}

const dab = (x: number, y: number): Dab => ({
  x,
  y,
  size: 10,
  strength: 1,
  angle: 0,
  roundness: 1,
  flipX: false,
  flipY: false,
});

describe('PaintSession', () => {
  it('a stroke begun while the one before is still painting waits for it (no paint is lost)', async () => {
    const { workspace, doc, bg, session } = setup();
    let open = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const brush = { ...DEFAULT_BRUSH, size: 10 };
    const first = new PaintSession(
      workspace,
      doc,
      bg,
      liveStroke(bg, [0, 0, 0], gate),
      'brush',
      brush,
      [0, 0, 0],
      1,
      null,
    );
    first.add([dab(20, 20)]);
    const firstDone = first.end([strokePoint(20, 20)]);
    // The next stroke starts on the same tile before the worker has painted the first.
    const second = new PaintSession(
      workspace,
      doc,
      bg,
      liveStroke(bg, [255, 0, 0], Promise.resolve()),
      'brush',
      brush,
      [255, 0, 0],
      2,
      null,
    );
    second.add([dab(60, 60)]);
    const secondDone = second.end([strokePoint(60, 60)]);
    open();
    await Promise.all([firstDone, secondDone]);
    expect(bg.buffer.getPixel(20, 20)).toEqual([0, 0, 0]);
    expect(bg.buffer.getPixel(60, 60)).toEqual([255, 0, 0]);
    expect(session.history.entries.map((e) => e.label)).toEqual(['Open', 'Brush Tool', 'Brush Tool']);
    await session.history.undo();
    expect(bg.buffer.getPixel(20, 20)).toEqual([0, 0, 0]);
    expect(bg.buffer.getPixel(60, 60)).toEqual([255, 255, 255]);
    await session.history.undo();
    expect(bg.buffer.getPixel(20, 20)).toEqual([255, 255, 255]);
  });
});
