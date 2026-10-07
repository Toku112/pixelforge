import { describe, expect, it } from 'vitest';
import { formatImageBytes, fromPixels, fromPpi, toPixels, toPpi } from '../../../../src/core/document/units';

describe('length units', () => {
  it('converts through the resolution and the base size', () => {
    expect(toPixels(2, 'inches', 300, 0)).toBe(600);
    expect(toPixels(2.54, 'centimeters', 300, 0)).toBeCloseTo(300);
    expect(toPixels(72, 'points', 150, 0)).toBe(150);
    expect(toPixels(6, 'picas', 72, 0)).toBe(72);
    expect(toPixels(50, 'percent', 72, 640)).toBe(320);
    expect(fromPixels(600, 'millimeters', 300, 0)).toBeCloseTo(50.8);
    expect(fromPixels(320, 'percent', 72, 640)).toBe(50);
    for (const unit of ['pixels', 'percent', 'inches', 'centimeters', 'millimeters', 'points', 'picas'] as const)
      expect(toPixels(fromPixels(123, unit, 240, 400), unit, 240, 400)).toBeCloseTo(123);
  });

  it('converts resolutions and formats memory sizes', () => {
    expect(toPpi(118.11, 'ppcm')).toBeCloseTo(300, 1);
    expect(fromPpi(254, 'ppcm')).toBeCloseTo(100);
    expect(formatImageBytes(96 * 64 * 3)).toBe('18K');
    expect(formatImageBytes(6000 * 4000 * 3)).toBe('68.7M');
    expect(formatImageBytes(2048)).toBe('2.0K');
  });
});
