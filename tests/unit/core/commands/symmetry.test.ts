import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../../../../src/core/commands/command';
import { DEFAULT_BRUSH, POINT_FIELDS, packPoints, strokePoint } from '../../../../src/core/paint/brush';
import { defaultSymmetry } from '../../../../src/core/paint/symmetry';
import { History } from '../../../../src/core/history/history';
import { createContext, withBackground } from '../helpers';

function setup() {
  const env = withBackground(createContext({ width: 100, height: 60 }));
  const layer = env.doc.createPixelLayer();
  env.doc.insertLayer(layer);
  env.doc.setActiveLayer(layer.id);
  const history = new History(env.doc);
  const run = (descriptor: CommandDescriptor) => history.execute(env.registry.create(env.ctx, descriptor));
  return { ...env, layer, history, run };
}

describe('symmetry commands', () => {
  it('setting, transforming and turning off symmetry are History steps', async () => {
    const { doc, history, run } = setup();
    const v = defaultSymmetry('vertical', 100, 60);
    await run({ name: 'setSymmetry', params: { symmetry: v as never } });
    await run({ name: 'setSymmetry', params: { symmetry: { ...v, cx: 30 } } });
    await run({ name: 'setSymmetry', params: { symmetry: { ...v, cx: 30, enabled: false } } });
    expect(history.entries.map((e) => e.label)).toEqual([
      expect.any(String),
      'New Symmetry',
      'Transform Symmetry',
      'Turn Off Symmetry',
    ]);
    expect(doc.symmetry?.enabled).toBe(false);
    await history.undo();
    expect(doc.symmetry).toMatchObject({ cx: 30, enabled: true });
    await history.undo();
    await history.undo();
    expect(doc.symmetry).toBeNull();
  });

  it('a stroke recorded with symmetry paints its mirror image when replayed', async () => {
    const { layer, run } = setup();
    await run({
      name: 'paintStroke',
      params: {
        tool: 'brush',
        points: packPoints([strokePoint(20, 20), strokePoint(30, 20)]),
        stride: POINT_FIELDS.length,
        brush: { ...DEFAULT_BRUSH, size: 6 } as never,
        color: [0, 0, 0],
        seed: 1,
        symmetry: defaultSymmetry('vertical', 100, 60) as never,
      },
    });
    const alpha = (x: number, y: number) => layer.buffer.getPixel(x, y)[3];
    expect(alpha(25, 20)).toBe(255);
    expect(alpha(74, 20)).toBe(255); // mirrored across x = 50
    expect(alpha(50, 20)).toBe(0);
  });
});
