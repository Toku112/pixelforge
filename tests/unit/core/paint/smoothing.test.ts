import { describe, expect, it } from 'vitest';
import { strokePoint, type StrokePoint } from '../../../../src/core/paint/brush';
import {
  CurveSmoother,
  DEFAULT_SMOOTHING,
  StrokeSmoother,
  smoothingRadius,
  type SmoothingOptions,
} from '../../../../src/core/paint/smoothing';

const at = (x: number, y: number, time: number): StrokePoint => ({ ...strokePoint(x, y), time });
const opts = (o: Partial<SmoothingOptions>): SmoothingOptions => ({ ...DEFAULT_SMOOTHING, ...o });

describe('stroke smoothing', () => {
  it('passes samples through at 0 %', () => {
    const s = new StrokeSmoother(opts({ amount: 0 }), 50);
    expect(s.add(at(0, 0, 0))).toEqual([at(0, 0, 0)]);
    expect(s.add(at(5, 3, 10))).toEqual([at(5, 3, 10)]);
  });

  it('pulled string: no mark within reach; then the paint trails the pointer at the string length', () => {
    const s = new StrokeSmoother(opts({ amount: 0.5, pulledString: true, catchUpOnEnd: true }), 10);
    s.add(at(0, 0, 0));
    expect(s.add(at(6, 0, 10))).toEqual([]);
    expect(s.add(at(0, 8, 20))).toEqual([]);
    const [p] = s.add(at(30, 0, 30));
    expect(p!.x).toBeCloseTo(20);
    expect(p!.y).toBeCloseTo(0);
    expect(s.tick(500)).toEqual([]); // no catching up in this mode
    // Releasing finishes the stroke at the pointer.
    expect(s.end().map((q) => [q.x, q.y])).toEqual([[30, 0]]);
  });

  it('otherwise the paint drifts to the pointer; Stroke Catch-up keeps it going while the pointer rests', () => {
    const s = new StrokeSmoother(opts({ amount: 1 }), 10); // drift time constant 150 ms
    s.add(at(0, 0, 0));
    const [p] = s.add(at(8, 0, 150)); // within reach: drift 1 − e⁻¹ of the way
    expect(p!.x).toBeCloseTo(8 * (1 - Math.exp(-1)));
    const later = s.tick(1500);
    expect(later[0]!.x).toBeGreaterThan(7.99);
    expect(s.end()).toEqual([]); // Catch-up on Stroke End is off by default
    const lazy = new StrokeSmoother(opts({ amount: 1, catchUp: false }), 10);
    lazy.add(at(0, 0, 0));
    lazy.add(at(8, 0, 150));
    expect(lazy.tick(1500)).toEqual([]);
  });

  it('keeps the string length on screen with Adjust for Zoom', () => {
    expect(smoothingRadius(opts({ amount: 0.5 }), 2, 1)).toBe(15); // 30 CSS px at 200 %
    expect(smoothingRadius(opts({ amount: 0.5 }), 0.5, 2)).toBe(120);
    expect(smoothingRadius(opts({ amount: 0.5, adjustForZoom: false }), 2, 1)).toBe(30);
  });

  it('draws curves through the samples, keeping every sample on the path', () => {
    const c = new CurveSmoother();
    const corner = [at(0, 0, 0), at(20, 0, 10), at(20, 20, 20), at(40, 20, 30)];
    const out = [...corner.flatMap((p) => c.push(p)), ...c.flush()];
    for (const p of corner) expect(out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-9)).toBe(true);
    expect(out.length).toBeGreaterThan(20);
    // Between the corners the path bulges off the straight lines (a curve, not a polyline).
    const offLine = out.filter((q) => q.y > 0.5 && q.y < 19.5 && Math.abs(q.x - 20) > 0.5);
    expect(offLine.length).toBeGreaterThan(0);
    // In order, never jumping back.
    for (let i = 1; i < out.length; i++) expect(out[i]!.time).toBeGreaterThanOrEqual(out[i - 1]!.time);
  });
});
