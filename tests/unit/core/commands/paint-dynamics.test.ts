import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../../../../src/core/commands/command';
import { DEFAULT_BRUSH, POINT_FIELDS, packPoints, strokePoint } from '../../../../src/core/paint/brush';
import { DEFAULT_DYNAMICS } from '../../../../src/core/paint/dynamics';
import { History } from '../../../../src/core/history/history';
import { createContext, withBackground } from '../helpers';

function layerPixels(seed: number) {
  const env = withBackground(createContext({ width: 120, height: 60 }));
  const doc = env.doc;
  const layer = doc.createPixelLayer();
  doc.insertLayer(layer);
  doc.setActiveLayer(layer.id);
  const history = new History(doc);
  const dynamics = structuredClone(DEFAULT_DYNAMICS);
  dynamics.shape.enabled = true;
  dynamics.shape.size.jitter = 1;
  dynamics.scatter.enabled = true;
  dynamics.scatter.amount = 1;
  dynamics.color.enabled = true;
  dynamics.color.hue = 0.5;
  const params: CommandDescriptor['params'] = {
    tool: 'brush',
    points: packPoints([strokePoint(10, 30), strokePoint(110, 30)]),
    stride: POINT_FIELDS.length,
    brush: { ...DEFAULT_BRUSH, size: 12, dynamics } as never,
    color: [200, 30, 30],
    seed,
    colors: { foreground: { r: 0.8, g: 0.1, b: 0.1 }, background: { r: 0, g: 0, b: 1 } },
  };
  return history
    .execute(env.registry.create(env.ctx, { name: 'paintStroke', params }))
    .then(() => Array.from(layer.buffer.readRegion({ x: 0, y: 0, w: 120, h: 60 })));
}

describe('replaying strokes with dynamics', () => {
  it('paints exactly the same with the same seed, differently with another', async () => {
    const a = await layerPixels(7);
    expect(await layerPixels(7)).toEqual(a);
    expect(await layerPixels(8)).not.toEqual(a);
    expect(a.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
  });
});
