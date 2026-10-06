import { describe, expect, it } from 'vitest';
import { createContext, withBackground } from '../helpers';

function setup() {
  const env = withBackground(createContext());
  const layer = env.doc.createPixelLayer();
  env.doc.insertLayer(layer);
  return { ...env, layer };
}

describe('setLayerProps command', () => {
  it('changes properties with undo and redo', async () => {
    const { ctx, registry, layer } = setup();
    const cmd = registry.create(ctx, { name: 'setLayerProps', params: { layerId: layer.id, props: { opacity: 0.4 } } });
    await cmd.execute();
    expect(layer.opacity).toBe(0.4);
    cmd.undo();
    expect(layer.opacity).toBe(1);
    cmd.redo();
    expect(layer.opacity).toBe(0.4);
  });

  it.each([
    [{ visible: false }, 'Hide Layer'],
    [{ visible: true }, 'Show Layer'],
    [{ name: 'Sky' }, 'Rename Layer'],
    [{ opacity: 0.5 }, 'Layer Opacity'],
    [{ fillOpacity: 0.5 }, 'Fill Opacity'],
    [{ blendMode: 'multiply' }, 'Blend Mode Change'],
    [{ offsetX: 4, offsetY: 2 }, 'Move'],
    [{ name: 'A', opacity: 0.5 }, 'Layer Properties'],
  ])('labels %j as "%s"', (props, label) => {
    const { ctx, registry, layer } = setup();
    expect(registry.create(ctx, { name: 'setLayerProps', params: { layerId: layer.id, props } }).label).toBe(label);
  });

  it('validates descriptor parameters', () => {
    const { ctx, registry, layer } = setup();
    const create = (params: Record<string, unknown>) =>
      registry.create(ctx, { name: 'setLayerProps', params: params as never });
    expect(() => create({ props: { opacity: 1 } })).toThrow('layerId');
    expect(() => create({ layerId: layer.id, props: {} })).toThrow('no properties');
    expect(() => create({ layerId: layer.id, props: { colour: 'red' } })).toThrow('unknown property "colour"');
    expect(() => create({ layerId: layer.id, props: { blendMode: 'glow' } })).toThrow('invalid value');
    expect(() => create({ layerId: layer.id, props: { visible: 'yes' } })).toThrow('invalid value');
  });

  it('respects Background rules at execution', async () => {
    const { doc, ctx, registry } = setup();
    const cmd = registry.create(ctx, {
      name: 'setLayerProps',
      params: { layerId: doc.background!.id, props: { opacity: 0.5 } },
    });
    await expect(async () => cmd.execute()).rejects.toThrow('fully opaque');
  });
});
