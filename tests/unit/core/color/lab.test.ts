import { describe, expect, it } from 'vitest';
import { linearSrgbToLab } from '../../../../src/core/color/lab';
import { linearToSrgb, srgb16ToLinearTable, srgb8ToLinearTable, srgbToLinear } from '../../../../src/core/color/srgb';

describe('sRGB transfer function', () => {
  it('maps the end points and the linear segment exactly', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(srgbToLinear(0.04045)).toBeCloseTo(0.04045 / 12.92, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214041, 6);
  });

  it('round-trips, including HDR and negative values', () => {
    for (const v of [-0.5, -0.001, 0, 0.002, 0.04, 0.2, 0.5, 0.9, 1, 1.5, 4]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 10);
    }
  });

  it('lookup tables agree with the formula', () => {
    const t8 = srgb8ToLinearTable();
    const t16 = srgb16ToLinearTable();
    expect(t8[128]).toBeCloseTo(srgbToLinear(128 / 255), 6);
    expect(t16[32768]).toBeCloseTo(srgbToLinear(32768 / 65535), 6);
    expect(t8[255]).toBeCloseTo(1, 6);
    expect(t16[65535]).toBeCloseTo(1, 6);
  });
});

describe('linear sRGB → L*a*b* (D50)', () => {
  it('maps white and black to the neutral axis ends', () => {
    const white = linearSrgbToLab(1, 1, 1);
    expect(white.L).toBeCloseTo(100, 6);
    expect(white.a).toBeCloseTo(0, 4);
    expect(white.b).toBeCloseTo(0, 4);
    expect(linearSrgbToLab(0, 0, 0)).toEqual({ L: 0, a: 0, b: 0 });
  });

  it('keeps greys neutral', () => {
    const g = linearSrgbToLab(0.2, 0.2, 0.2);
    expect(g.a).toBeCloseTo(0, 4);
    expect(g.b).toBeCloseTo(0, 4);
    expect(g.L).toBeCloseTo(116 * Math.cbrt(0.2) - 16, 6);
  });

  // Reference values: sRGB primaries in D50 Lab with Bradford adaptation.
  it.each([
    ['red', [1, 0, 0], [54.29, 80.81, 69.89]],
    ['green', [0, 1, 0], [87.82, -79.29, 80.99]],
    ['blue', [0, 0, 1], [29.57, 68.29, -112.03]],
  ] as const)('converts the sRGB %s primary', (_name, rgb, lab) => {
    const out = linearSrgbToLab(rgb[0], rgb[1], rgb[2]);
    expect(out.L).toBeCloseTo(lab[0], 1);
    expect(out.a).toBeCloseTo(lab[1], 1);
    expect(out.b).toBeCloseTo(lab[2], 1);
  });
});
