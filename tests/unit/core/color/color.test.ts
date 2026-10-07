import { describe, expect, it } from 'vitest';
import {
  BLACK,
  WHITE,
  colorToSamples,
  hexToRgb,
  hsbToRgb,
  labToRgb,
  rgb8,
  rgbToHex,
  rgbToHsb,
  rgbToLab,
} from '../../../../src/core/color/color';

describe('colours', () => {
  it('converts between RGB and HSB', () => {
    expect(rgbToHsb({ r: 1, g: 0, b: 0 })).toEqual({ h: 0, s: 1, b: 1 });
    expect(rgbToHsb({ r: 0, g: 0.5, b: 0.5 })).toEqual({ h: 180, s: 1, b: 0.5 });
    expect(rgbToHsb(BLACK)).toEqual({ h: 0, s: 0, b: 0 });
    for (const c of [
      { r: 0.2, g: 0.4, b: 0.9 },
      { r: 0.9, g: 0.85, b: 0.1 },
      { r: 0.3, g: 0.3, b: 0.3 },
    ]) {
      const back = hsbToRgb(rgbToHsb(c));
      expect(back.r).toBeCloseTo(c.r, 12);
      expect(back.g).toBeCloseTo(c.g, 12);
      expect(back.b).toBeCloseTo(c.b, 12);
    }
    expect(rgb8(hsbToRgb({ h: 240, s: 1, b: 1 }))).toEqual([0, 0, 255]);
  });

  it('reads and writes hexadecimal colours', () => {
    expect(rgbToHex({ r: 1, g: 0.5, b: 0 })).toBe('FF8000');
    expect(rgb8(hexToRgb('#ff8000')!)).toEqual([255, 128, 0]);
    expect(rgb8(hexToRgb('0f8')!)).toEqual([0, 255, 136]);
    expect(hexToRgb('nope')).toBeNull();
    expect(hexToRgb('12345')).toBeNull();
  });

  it('converts to and from L*a*b* (D50)', () => {
    const white = rgbToLab(WHITE);
    expect(white.L).toBeCloseTo(100, 4);
    expect(white.a).toBeCloseTo(0, 4);
    expect(white.b).toBeCloseTo(0, 4);
    const red = rgbToLab({ r: 1, g: 0, b: 0 });
    expect(red.L).toBeCloseTo(54.29, 1); // sRGB red in D50 Lab
    for (const c of [
      { r: 0.2, g: 0.4, b: 0.9 },
      { r: 0.9, g: 0.85, b: 0.1 },
    ]) {
      const back = labToRgb(rgbToLab(c));
      expect(back.r).toBeCloseTo(c.r, 6);
      expect(back.g).toBeCloseTo(c.g, 6);
      expect(back.b).toBeCloseTo(c.b, 6);
    }
    // Out of gamut: clipped.
    const vivid = labToRgb({ L: 50, a: 120, b: -120 });
    expect(Math.max(vivid.r, vivid.g, vivid.b)).toBeLessThanOrEqual(1);
    expect(Math.min(vivid.r, vivid.g, vivid.b)).toBeGreaterThanOrEqual(0);
  });

  it('turns a colour into document samples', () => {
    const c = { r: 1, g: 0.5, b: 0 };
    expect(colorToSamples(c, 'rgb', 8)).toEqual([255, 128, 0]);
    expect(colorToSamples(c, 'rgb', 16)).toEqual([65535, 32768, 0]);
    const linear = colorToSamples(c, 'rgb', 32);
    expect(linear[1]).toBeCloseTo(0.214, 3);
    expect(colorToSamples(WHITE, 'grayscale', 8)).toEqual([255]);
    expect(colorToSamples(c, 'grayscale', 8)).toEqual([Math.round((0.299 + 0.587 * 0.5) * 255)]);
    expect(() => colorToSamples(c, 'cmyk', 8)).toThrow('colour management');
  });
});
