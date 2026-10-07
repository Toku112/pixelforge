import { describe, expect, it } from 'vitest';
import {
  BLEND_MODE_LABELS,
  HDR_MAX,
  availableBlendModes,
  blendChannel,
  blendColor,
  blendModeMenu,
  cycleBlendMode,
  dissolveNoise,
  fillSource,
} from '../../../../src/core/composite/blend';
import { compositeToSamples, flatten, planFromDocument } from '../../../../src/core/composite/flatten';
import { ImageDocument } from '../../../../src/core/document/document';
import { LAYER_BLEND_MODES, type LayerBlendMode } from '../../../../src/core/document/layers';

const sep = (mode: LayerBlendMode, b: number, s: number, fill = 1) => blendChannel(mode, b, s, fill);

describe('separable blend formulas', () => {
  it.each([
    // mode, backdrop, source, expected
    ['normal', 0.2, 0.7, 0.7],
    ['darken', 0.2, 0.7, 0.2],
    ['multiply', 0.5, 0.5, 0.25],
    ['color-burn', 0.5, 0.5, 0],
    ['color-burn', 0.8, 0.5, 0.6],
    ['color-burn', 1, 0, 1],
    ['linear-burn', 0.7, 0.6, 0.3],
    ['linear-burn', 0.2, 0.3, 0],
    ['lighten', 0.2, 0.7, 0.7],
    ['screen', 0.5, 0.5, 0.75],
    ['color-dodge', 0.25, 0.5, 0.5],
    ['color-dodge', 0, 1, 0],
    ['color-dodge', 0.6, 0.5, 1],
    ['linear-dodge', 0.3, 0.4, 0.7],
    ['linear-dodge', 0.8, 0.4, 1],
    ['overlay', 0.25, 0.8, 0.4],
    ['overlay', 0.75, 0.2, 0.6],
    ['soft-light', 0.25, 0.25, 0.15625],
    ['soft-light', 0.25, 0.75, 0.375],
    ['hard-light', 0.8, 0.25, 0.4],
    ['hard-light', 0.2, 0.75, 0.6],
    ['vivid-light', 0.6, 0.4, 0.5],
    ['vivid-light', 0.4, 0.75, 0.8],
    ['linear-light', 0.4, 0.75, 0.9],
    ['linear-light', 0.4, 0.1, 0],
    ['pin-light', 0.6, 0.2, 0.4],
    ['pin-light', 0.3, 0.8, 0.6],
    ['hard-mix', 0.6, 0.4, 1],
    ['hard-mix', 0.6, 0.39, 0],
    ['difference', 0.2, 0.7, 0.5],
    ['exclusion', 0.5, 0.5, 0.5],
    ['subtract', 0.7, 0.2, 0.5],
    ['subtract', 0.2, 0.7, 0],
    ['divide', 0.25, 0.5, 0.5],
    ['divide', 0.6, 0.5, 1],
    ['divide', 0, 0, 0],
    ['divide', 0.3, 0, 1],
  ] as const)('%s(%d, %d) = %d', (mode, b, s, expected) => {
    expect(sep(mode, b, s)).toBeCloseTo(expected, 10);
  });

  it('keeps high values in 32-bit for Linear Dodge', () => {
    expect(blendChannel('linear-dodge', 0.8, 0.9, 1, true)).toBeCloseTo(1.7);
  });

  it('applies Fill inside the formula for the special eight', () => {
    expect(fillSource('color-dodge', 1, 0.5)).toBe(0.5); // towards black
    expect(fillSource('color-burn', 0, 0.5)).toBe(0.5); // towards white
    expect(fillSource('linear-light', 1, 0.5)).toBe(0.75); // towards 50 % grey
    expect(sep('linear-dodge', 0.5, 0.8, 0.5)).toBeCloseTo(0.9);
    expect(sep('difference', 0.5, 1, 0.25)).toBeCloseTo(0.25);
    // Hard Mix: a hard threshold at full Fill, a contrast ramp at lower Fill, no effect at zero Fill.
    expect(sep('hard-mix', 0.3, 0.5, 0)).toBeCloseTo(0.3);
    expect(sep('hard-mix', 0.6, 0.6, 0.5)).toBeCloseTo(0.8);
  });
});

describe('whole-colour blend modes', () => {
  it('Darker/Lighter Color pick the colour with the lower/higher channel sum', () => {
    expect(blendColor('darker-color', [0.9, 0.1, 0.1], [0.4, 0.4, 0.4])).toEqual([0.9, 0.1, 0.1]);
    expect(blendColor('lighter-color', [0.9, 0.1, 0.1], [0.4, 0.4, 0.4])).toEqual([0.4, 0.4, 0.4]);
  });

  it('Luminosity keeps the backdrop colour with the source lightness, Color the reverse', () => {
    const lum = (c: number[]) => 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;
    const red = [0.8, 0.2, 0.2];
    const grey = [0.6, 0.6, 0.6];
    expect(lum(blendColor('luminosity', red, grey))).toBeCloseTo(0.6, 6);
    expect(lum(blendColor('color', grey, red))).toBeCloseTo(0.6, 6);
    const c = blendColor('color', grey, red);
    expect(c[0]).toBeGreaterThan(c[1]!); // reddish
    expect(blendColor('saturation', red, grey)).toEqual(expect.arrayContaining([expect.any(Number)]));
    const s = blendColor('saturation', red, grey); // grey has no saturation → backdrop becomes grey
    expect(s[0]).toBeCloseTo(s[1]!, 6);
    const h = blendColor('hue', [0.2, 0.6, 0.2], [0.8, 0.2, 0.2]); // hue of red onto green's saturation/lightness
    expect(h[0]).toBeGreaterThan(h[1]!);
  });
});

describe('32-bit (HDR) results', () => {
  it('keeps values above 1 where the formula allows', () => {
    expect(blendChannel('linear-dodge', 0.8, 0.9, 1, true)).toBeCloseTo(1.7, 9);
    expect(blendChannel('linear-dodge', 0.8, 0.9, 1, false)).toBe(1);
    expect(blendChannel('divide', 3, 0.5, 1, true)).toBe(6);
  });

  it('caps Divide by black at the largest value the composite holds', () => {
    expect(blendChannel('divide', 0.5, 0, 1, true)).toBe(HDR_MAX);
    expect(blendChannel('divide', 0, 0, 1, true)).toBe(0);
    expect(blendChannel('divide', 2, 1e-9, 1, true)).toBe(HDR_MAX);
  });

  it('colour modes keep bright values instead of clipping them to 1', () => {
    const bright = [3, 3, 3];
    const red = [1, 0, 0];
    const c = blendColor('color', bright, red, true);
    expect(c.every(Number.isFinite)).toBe(true);
    expect(0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!).toBeCloseTo(3, 9);
    expect(c[0]!).toBeGreaterThan(c[1]!);
    // Without HDR a light backdrop is clipped back into 0–1, keeping its luminosity.
    const clipped = blendColor('color', [0.95, 0.95, 0.95], red);
    expect(clipped.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(0.3 * clipped[0]! + 0.59 * clipped[1]! + 0.11 * clipped[2]!).toBeCloseTo(0.95, 9);
  });
});

describe('Dissolve noise', () => {
  it('is deterministic, in [0, 1) and roughly uniform', () => {
    expect(dissolveNoise(10, 20)).toBe(dissolveNoise(10, 20));
    let sum = 0;
    let below = 0;
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const v = dissolveNoise(x, y);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
        sum += v;
        if (v < 0.3) below++;
      }
    }
    expect(sum / 10000).toBeCloseTo(0.5, 1);
    expect(below / 10000).toBeCloseTo(0.3, 1);
  });
});

describe('blend modes in the compositor', () => {
  function stack(
    mode: LayerBlendMode,
    opts: { opacity?: number; fill?: number; backdrop?: number[]; source?: number[]; docMode?: 'rgb' | 'cmyk' } = {},
  ) {
    const docMode = opts.docMode ?? 'rgb';
    const doc = new ImageDocument({ width: 2, height: 1, mode: docMode });
    const bg = doc.createBackgroundLayer(opts.backdrop ?? (docMode === 'cmyk' ? [0, 0, 0, 0] : [128, 64, 200]));
    doc.insertLayer(bg);
    const l = doc.createPixelLayer();
    doc.insertLayer(l);
    const src = opts.source ?? [200, 100, 50, 255];
    l.buffer.writeRegion({ x: 0, y: 0, w: 2, h: 1 }, new Uint8Array([...src, ...src]));
    doc.updateLayer(l.id, { blendMode: mode, opacity: opts.opacity ?? 1, fillOpacity: opts.fill ?? 1 });
    return [...compositeToSamples(flatten(planFromDocument(doc)), 8, false).subarray(0, doc.colorChannels)];
  }

  it('composites every blend mode without error, matching the formulas on an opaque backdrop', () => {
    for (const mode of LAYER_BLEND_MODES) {
      if (mode === 'dissolve') continue;
      const out = stack(mode);
      if (['darker-color', 'lighter-color', 'hue', 'saturation', 'color', 'luminosity'].includes(mode)) {
        const expected = blendColor(mode, [128 / 255, 64 / 255, 200 / 255], [200 / 255, 100 / 255, 50 / 255]).map((v) =>
          Math.round(v * 255),
        );
        expect(out, mode).toEqual(expected);
      } else {
        const expected = [128, 64, 200].map((b, i) =>
          Math.round(blendChannel(mode, b / 255, [200, 100, 50][i]! / 255) * 255),
        );
        expect(out, mode).toEqual(expected);
      }
    }
  });

  it('treats Fill and Opacity the same for ordinary modes but differently for the special eight', () => {
    expect(stack('multiply', { fill: 0.5 })).toEqual(stack('multiply', { opacity: 0.5 }));
    expect(stack('color-dodge', { fill: 0.5 })).not.toEqual(stack('color-dodge', { opacity: 0.5 }));
    expect(stack('hard-mix', { fill: 0.5 })).not.toEqual(stack('hard-mix', { opacity: 0.5 }));
  });

  it('shows a blended layer as-is over transparency', () => {
    const doc = new ImageDocument({ width: 1, height: 1 });
    const l = doc.createPixelLayer();
    doc.insertLayer(l);
    l.buffer.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([200, 100, 50, 255]));
    doc.updateLayer(l.id, { blendMode: 'multiply' });
    expect([...compositeToSamples(flatten(planFromDocument(doc)), 8, true)]).toEqual([200, 100, 50, 255]);
  });

  it('Dissolve shows pixels fully or not at all, in proportion to opacity', () => {
    const doc = new ImageDocument({ width: 64, height: 64 });
    doc.insertLayer(doc.createBackgroundLayer());
    const l = doc.createPixelLayer();
    doc.insertLayer(l);
    l.buffer.writeRegion(
      { x: 0, y: 0, w: 64, h: 64 },
      new Uint8Array(64 * 64 * 4).map((_, i) => (i % 4 === 3 ? 255 : 0)),
    );
    doc.updateLayer(l.id, { blendMode: 'dissolve', opacity: 0.25 });
    const out = compositeToSamples(flatten(planFromDocument(doc)), 8, false);
    const values = new Set(out);
    expect([...values].sort((a, b) => a - b)).toEqual([0, 255]);
    const black = [...out].filter((v, i) => i % 3 === 0 && v === 0).length / (64 * 64);
    expect(black).toBeCloseTo(0.25, 1);
  });

  it('blends CMYK documents on inverted values (Multiply darkens = adds ink)', () => {
    // 50 % cyan ink over 50 % cyan ink with Multiply → 1 − (1 − 0.502)² = 75.2 % ink (191.75 → 192).
    const out = stack('multiply', { docMode: 'cmyk', backdrop: [128, 0, 0, 0], source: [128, 0, 0, 0, 255] });
    expect(out[0]).toBe(192);
  });

  it('offers the right blend modes per document type', () => {
    expect(availableBlendModes('rgb', 8)).toHaveLength(27);
    expect(availableBlendModes('grayscale', 8)).not.toContain('hue');
    expect(availableBlendModes('rgb', 32)).not.toContain('overlay');
    expect(availableBlendModes('rgb', 32)).toContain('linear-dodge');
  });

  it('builds per-layer menus and cycles through them with wrap-around', () => {
    const pixel = blendModeMenu('pixel', 'rgb', 8);
    const group = blendModeMenu('group', 'rgb', 8);
    expect(pixel[0]).toBe('normal');
    expect(group[0]).toBe('pass-through');
    expect(group).toHaveLength(28);
    expect(cycleBlendMode(pixel, 'normal', 1)).toBe('dissolve');
    expect(cycleBlendMode(pixel, 'normal', -1)).toBe('luminosity');
    expect(cycleBlendMode(pixel, 'luminosity', 1)).toBe('normal');
    expect(cycleBlendMode(group, 'luminosity', 1)).toBe('pass-through');
    expect(cycleBlendMode(group, 'pass-through', 1)).toBe('normal');
    // A mode the document does not offer (Overlay in 32-bit) starts at either end.
    const hdr = blendModeMenu('pixel', 'rgb', 32);
    expect(cycleBlendMode(hdr, 'overlay', 1)).toBe('normal');
    expect(cycleBlendMode(hdr, 'overlay', -1)).toBe('luminosity');
  });

  it('names every blend mode', () => {
    for (const mode of [...LAYER_BLEND_MODES, 'pass-through' as const]) expect(BLEND_MODE_LABELS[mode]).toBeTruthy();
    expect(BLEND_MODE_LABELS['linear-dodge']).toBe('Linear Dodge (Add)');
  });
});
