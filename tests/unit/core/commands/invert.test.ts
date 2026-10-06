import { describe, expect, it } from 'vitest';
import { CommandUnavailableError, type PixelOps } from '../../../../src/core/commands/command';
import { createContext, withBackground } from '../helpers';

const invert = { name: 'invert', params: {} };

describe('Invert command', () => {
  it('turns a white Background black across the whole canvas, undoes and redoes', async () => {
    const { doc, ctx, registry } = withBackground(createContext());
    const bg = doc.background!;
    const cmd = registry.create(ctx, invert);
    expect(cmd.label).toBe('Invert');
    await cmd.execute();
    expect(bg.buffer.getPixel(0, 0)).toEqual([0, 0, 0]);
    expect(bg.buffer.getPixel(299, 199)).toEqual([0, 0, 0]);
    expect(bg.buffer.tileCount).toBe(2); // 300×200 canvas → 2×1 tiles
    expect(cmd.undoBytes).toBeGreaterThan(0);

    cmd.undo();
    expect(bg.buffer.getPixel(150, 100)).toEqual([255, 255, 255]);
    expect(bg.buffer.tileCount).toBe(0); // back to the unallocated white default

    cmd.redo();
    expect(bg.buffer.getPixel(150, 100)).toEqual([0, 0, 0]);
  });

  it('inverts colour but not alpha, and leaves empty areas unallocated', async () => {
    const { doc, ctx, registry } = withBackground(createContext());
    const layer = doc.createPixelLayer();
    doc.insertLayer(layer);
    doc.setActiveLayer(layer.id);
    layer.buffer.writeRegion({ x: 10, y: 10, w: 2, h: 1 }, new Uint8Array([10, 20, 30, 128, 0, 0, 0, 0]));
    await registry.create(ctx, invert).execute();
    expect(layer.buffer.getPixel(10, 10)).toEqual([245, 235, 225, 128]);
    expect(layer.buffer.getPixel(11, 10)).toEqual([255, 255, 255, 0]);
    expect(layer.buffer.tileCount).toBe(1);
    expect(doc.background!.buffer.getPixel(0, 0)).toEqual([255, 255, 255]); // other layers untouched
  });

  it('inverts 16-bit documents over 0–65535', async () => {
    const { doc, ctx, registry } = withBackground(createContext({ depth: 16 }));
    doc.background!.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint16Array([0, 32768, 65535]));
    await registry.create(ctx, invert).execute();
    expect(doc.background!.buffer.getPixel(0, 0)).toEqual([65535, 32767, 0]);
    expect(doc.background!.buffer.getPixel(5, 5)).toEqual([0, 0, 0]);
  });

  it('inverts CMYK ink amounts and grayscale', async () => {
    const cmyk = withBackground(createContext({ mode: 'cmyk' }));
    await cmyk.registry.create(cmyk.ctx, invert).execute();
    expect(cmyk.doc.background!.buffer.getPixel(0, 0)).toEqual([255, 255, 255, 255]); // white paper → full ink

    const gray = withBackground(createContext({ mode: 'grayscale' }));
    await gray.registry.create(gray.ctx, invert).execute();
    expect(gray.doc.background!.buffer.getPixel(0, 0)).toEqual([0]);
  });

  it('is unavailable without an editable pixel layer or in unsupported modes', async () => {
    const none = createContext();
    expect(none.registry.isAvailable('invert', none.ctx)).toBe(false);
    await expect(none.registry.create(none.ctx, invert).execute()).rejects.toBeInstanceOf(CommandUnavailableError);

    for (const init of [{ depth: 32 as const }, { mode: 'lab' as const }]) {
      const env = withBackground(createContext(init));
      expect(env.registry.isAvailable('invert', env.ctx)).toBe(false);
    }

    const locked = withBackground(createContext());
    const layer = locked.doc.createPixelLayer();
    locked.doc.insertLayer(layer);
    locked.doc.setActiveLayer(layer.id);
    expect(locked.registry.isAvailable('invert', locked.ctx)).toBe(true);
    locked.doc.updateLayer(layer.id, {
      locks: { transparency: false, pixels: true, position: false, artboardNesting: false, all: false },
    });
    expect(locked.registry.isAvailable('invert', locked.ctx)).toBe(false);
  });

  it('leaves the document unchanged when the pixel worker fails', async () => {
    const failing: PixelOps = {
      invert: (tiles) => {
        tiles[0]!.fill(7); // partial write before failing
        return Promise.reject(new Error('worker crashed'));
      },
    };
    const { doc, ctx, registry } = withBackground(createContext({}, failing));
    const layer = doc.background!;
    layer.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([1, 2, 3]));
    const before = layer.buffer.getTile(0, 0)!;
    await expect(registry.create(ctx, invert).execute()).rejects.toThrow('worker crashed');
    expect(layer.buffer.getPixel(0, 0)).toEqual([1, 2, 3]);
    expect(layer.buffer.getTile(0, 0)).toBe(before);
    expect(layer.buffer.getTile(1, 0)).toBeUndefined();
  });

  it('stores only the changed tiles as undo data, sharing unchanged ones', async () => {
    const { doc, ctx, registry } = withBackground(createContext({ width: 1024, height: 1024 }));
    const layer = doc.createPixelLayer();
    doc.insertLayer(layer);
    doc.setActiveLayer(layer.id);
    layer.buffer.writeRegion({ x: 600, y: 600, w: 1, h: 1 }, new Uint8Array([1, 1, 1, 255]));
    const cmd = registry.create(ctx, invert);
    await cmd.execute();
    // One allocated tile (256×256 RGBA8) → before + after versions.
    expect(cmd.undoBytes).toBe(2 * 256 * 256 * 4);
  });
});
