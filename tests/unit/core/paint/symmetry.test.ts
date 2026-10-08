import { describe, expect, it } from 'vitest';
import type { Dab } from '../../../../src/core/paint/brush';
import {
  applySymmetry,
  defaultSymmetry,
  parseSymmetry,
  symmetryCopies,
  symmetryGuide,
  type Symmetry,
} from '../../../../src/core/paint/symmetry';
import { symmetryLabel } from '../../../../src/core/commands/builtin/symmetry';

const dab = (x: number, y: number, angle = 0): Dab => ({
  x,
  y,
  size: 10,
  strength: 1,
  angle,
  roundness: 1,
  flipX: false,
  flipY: false,
});
const sym = (o: Partial<Symmetry>): Symmetry => ({ ...defaultSymmetry('vertical', 200, 200), ...o });
const where = (dabs: Dab[]) => dabs.map((d) => [Math.round(d.x * 1000) / 1000, Math.round(d.y * 1000) / 1000]);

describe('paint symmetry', () => {
  it('vertical: mirrors across the vertical line through the centre, mirroring the tip', () => {
    const out = applySymmetry([dab(110, 105, 30)], symmetryCopies(sym({ kind: 'vertical' })));
    expect(where(out)).toEqual([
      [110, 105],
      [90, 105],
    ]);
    expect(out[1]!.angle).toBeCloseTo(150);
    expect(out[1]!.flipY).toBe(true);
  });

  it('horizontal, dual axis and a turned guide', () => {
    expect(where(applySymmetry([dab(110, 105)], symmetryCopies(sym({ kind: 'horizontal' }))))).toEqual([
      [110, 105],
      [110, 95],
    ]);
    expect(where(applySymmetry([dab(110, 105)], symmetryCopies(sym({ kind: 'dual' }))))).toEqual([
      [110, 105],
      [90, 105],
      [110, 95],
      [90, 95],
    ]);
    // A vertical guide turned 90° mirrors like a horizontal one.
    expect(where(applySymmetry([dab(110, 105)], symmetryCopies(sym({ kind: 'vertical', angle: 90 }))))[1]).toEqual([
      110, 95,
    ]);
  });

  it('radial turns copies around the centre; mandala also mirrors them (twice as many)', () => {
    const radial = applySymmetry([dab(120, 100, 10)], symmetryCopies(sym({ kind: 'radial', segments: 4 })));
    expect(where(radial)).toEqual([
      [120, 100],
      [100, 80], // a quarter turn counter-clockwise on screen
      [80, 100],
      [100, 120],
    ]);
    expect(radial[1]!.angle).toBeCloseTo(100);
    const mandala = applySymmetry([dab(120, 104)], symmetryCopies(sym({ kind: 'mandala', segments: 3 })));
    expect(mandala).toHaveLength(6);
    const r = Math.hypot(20, 4);
    for (const d of mandala) expect(Math.hypot(d.x - 100, d.y - 100)).toBeCloseTo(r);
    expect(new Set(where(mandala).map(String)).size).toBe(6);
  });

  it('circle mirrors across the edge; spiral and wavy leave points on their curve where they are', () => {
    const circle = symmetryCopies(sym({ kind: 'circle', size: 40 }));
    expect(where(applySymmetry([dab(120, 100)], circle))[1]).toEqual([160, 100]);
    expect(applySymmetry([dab(200, 100)], circle)).toHaveLength(1); // its mirror would be past the centre
    const spiral = symmetryCopies(sym({ kind: 'spiral', size: 20 }));
    const onArm = dab(100 + 25, 100); // angle 0, one and a quarter turns out? r = 20 × (0 + 1) = 20 is an arm
    expect(where(applySymmetry([dab(120, 100)], spiral))[1]).toEqual([120, 100]);
    expect(applySymmetry([onArm], spiral)[1]!.x).toBeCloseTo(115);
    const wavy = symmetryCopies(sym({ kind: 'wavy', size: 40 }));
    // u = 10 is the wave's crest (height 10, up on screen): a point on it stays; one below goes above.
    expect(where(applySymmetry([dab(110, 90)], wavy))[1]).toEqual([110, 90]);
    expect(where(applySymmetry([dab(110, 100)], wavy))[1]).toEqual([110, 80]);
  });

  it('parallel lines mirror across both lines', () => {
    const out = applySymmetry([dab(100, 105)], symmetryCopies(sym({ kind: 'parallel', size: 40 })));
    expect(where(out)).toEqual([
      [100, 105],
      [100, 135],
      [100, 55],
    ]);
  });

  it('draws guides, reads recorded symmetries and names the History steps', () => {
    expect(symmetryGuide(sym({ kind: 'dual' }), 300)).toHaveLength(2);
    expect(symmetryGuide(sym({ kind: 'radial', segments: 7 }), 300)).toHaveLength(7);
    expect(symmetryGuide(sym({ kind: 'circle' }), 300)[0]!.closed).toBe(true);
    expect(parseSymmetry({ kind: 'mandala', cx: 1, cy: 2, angle: 0, size: 5, segments: 8 }).segments).toBe(8);
    expect(() => parseSymmetry({ kind: 'mirror', cx: 0, cy: 0, angle: 0, size: 5 })).toThrow(/kind/);
    expect(() => parseSymmetry({ kind: 'radial', cx: 0, cy: 0, angle: 0, size: 5, segments: 20 })).toThrow(/segments/);
    const v = sym({ kind: 'vertical' });
    expect(symmetryLabel(null, v)).toBe('New Symmetry');
    expect(symmetryLabel(v, { ...v, cx: 5 })).toBe('Transform Symmetry');
    expect(symmetryLabel(v, { ...v, enabled: false })).toBe('Turn Off Symmetry');
    expect(symmetryLabel(v, { ...v, kind: 'dual' })).toBe('New Symmetry');
  });
});
