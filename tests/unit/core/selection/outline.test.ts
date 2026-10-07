import { describe, expect, it } from 'vitest';
import { selectShape } from '../../../../src/core/selection/mask-ops';
import { selectionOutline } from '../../../../src/core/selection/outline';
import { Selection } from '../../../../src/core/selection/selection';

const canvas = { x: 0, y: 0, w: 600, h: 400 };
const rect = (x: number, y: number, w: number, h: number) => ({ kind: 'rect' as const, x, y, w, h });

/** Loops as sorted lists of "x,y" corners, for order-independent comparison. */
const corners = (loops: Float32Array[]) =>
  loops.map((l) => {
    const pts: string[] = [];
    for (let i = 0; i < l.length; i += 2) pts.push(`${l[i]},${l[i + 1]}`);
    return pts.sort();
  });

describe('selection outline (marching ants)', () => {
  it('traces a rectangle as one loop of four corners', () => {
    const mask = selectShape(null, rect(10, 20, 300, 5), 'new', 0, false, canvas)!;
    expect(corners(selectionOutline(mask, canvas))).toEqual([['10,20', '10,25', '310,20', '310,25']]);
  });

  it('gives separate loops for separate areas and for holes', () => {
    const two = selectShape(
      selectShape(null, rect(0, 0, 10, 10), 'new', 0, false, canvas),
      rect(300, 300, 10, 10),
      'add',
      0,
      false,
      canvas,
    )!;
    expect(selectionOutline(two, canvas)).toHaveLength(2);
    const hole = selectShape(Selection.all().data, rect(100, 100, 50, 50), 'subtract', 0, false, canvas)!;
    expect(corners(selectionOutline(hole, canvas)).sort()).toEqual(
      [
        ['0,0', '0,400', '600,0', '600,400'],
        ['100,100', '100,150', '150,100', '150,150'],
      ].sort(),
    );
  });

  it('outlines Select All as the canvas, and follows the half-selected edge of feathered selections', () => {
    expect(corners(selectionOutline(Selection.all().data, canvas))).toEqual([['0,0', '0,400', '600,0', '600,400']]);
    const soft = selectShape(null, rect(100, 100, 200, 100), 'new', 8, true, canvas)!;
    const [loop] = selectionOutline(soft, canvas);
    const xs = [...loop!].filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(97);
    expect(Math.max(...xs)).toBeLessThanOrEqual(303);
  });
});
