import { describe, expect, it } from 'vitest';
import {
  MaskReader,
  featherTiles,
  invertSelection,
  maskIsEmpty,
  rasterizePolygon,
  selectShape,
  shapePoints,
  type SelectionShape,
} from '../../../../src/core/selection/mask-ops';
import { Selection, type MaskData } from '../../../../src/core/selection/selection';

const canvas = { x: 0, y: 0, w: 600, h: 400 };
const rect = (x: number, y: number, w: number, h: number): SelectionShape => ({ kind: 'rect', x, y, w, h });
const at = (mask: MaskData | null, x: number, y: number) => (mask ? new Selection(mask).value(x, y, canvas) : 0);
const select = (
  shape: SelectionShape,
  current: MaskData | null = null,
  mode: 'new' | 'add' | 'subtract' | 'intersect' = 'new',
  feather = 0,
  aa = true,
) => selectShape(current, shape, mode, feather, aa, canvas);

/** Sum of mask values / 255 over the canvas (selected area in pixels). */
function area(mask: MaskData | null): number {
  if (!mask) return 0;
  const sel = new Selection(mask);
  let sum = 0;
  for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) sum += sel.value(x, y, canvas);
  return sum / 255;
}

describe('drawing selection shapes', () => {
  it('fills whole-pixel rectangles exactly, with or without anti-aliasing', () => {
    for (const aa of [true, false]) {
      const m = select(rect(10, 20, 300, 5), null, 'new', 0, aa);
      expect([at(m, 10, 20), at(m, 309, 24), at(m, 9, 20), at(m, 310, 20), at(m, 10, 25)]).toEqual([255, 255, 0, 0, 0]);
      expect(area(m)).toBe(1500);
    }
  });

  it('anti-aliases ellipse edges and keeps the area of the ellipse', () => {
    const m = select({ kind: 'ellipse', x: 100, y: 100, w: 200, h: 100 });
    expect(area(m)).toBeCloseTo(Math.PI * 100 * 50, -2);
    expect(at(m, 200, 150)).toBe(255);
    const edge = at(m, 100, 150); // the leftmost column is partly covered
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    const hard = select({ kind: 'ellipse', x: 100, y: 100, w: 200, h: 100 }, null, 'new', 0, false);
    const values = new Set<number>();
    for (let x = 95; x < 110; x++) values.add(at(hard, x, 150));
    expect([...values].sort((a, b) => a - b)).toEqual([0, 255]);
  });

  it('fills self-overlapping lassos with the even-odd rule (overlaps become holes)', () => {
    // Two overlapping squares drawn as one path: the overlap is crossed twice.
    const points = [0, 0, 200, 0, 200, 200, 100, 200, 100, 100, 300, 100, 300, 300, 100, 300, 100, 200, 0, 200];
    const tiles = rasterizePolygon(points, false, canvas);
    const m: MaskData = { tiles: [...tiles.values()], fill: 0, offsetX: 0, offsetY: 0 };
    expect([at(m, 50, 50), at(m, 250, 250), at(m, 150, 150)]).toEqual([255, 255, 0]);
  });

  it('turns ellipses into smooth polygons', () => {
    expect(shapePoints({ kind: 'ellipse', x: 0, y: 0, w: 1000, h: 1000 }).length / 2).toBeGreaterThan(3000);
  });
});

describe('feather', () => {
  it('blurs a hard edge like a Gaussian whose standard deviation is the radius', () => {
    const hard = select(rect(0, 0, 300, 400));
    const soft = select(rect(0, 0, 300, 400), null, 'new', 10);
    expect(at(hard, 299, 200)).toBe(255);
    // At the edge ≈ half; one radius inside ≈ 84 %, one radius outside ≈ 16 %.
    expect(Math.abs(at(soft, 300, 200) - 128)).toBeLessThan(10);
    expect(Math.abs(at(soft, 290, 200) - 0.841 * 255)).toBeLessThan(10);
    expect(Math.abs(at(soft, 310, 200) - 0.159 * 255)).toBeLessThan(10);
    expect(at(soft, 100, 200)).toBe(255);
    expect(at(soft, 400, 200)).toBe(0);
  });

  it('returns the tiles unchanged for radius 0', () => {
    const tiles = rasterizePolygon(shapePoints(rect(0, 0, 10, 10)), false, canvas);
    expect(featherTiles(tiles, 0, canvas)).toBe(tiles);
  });
});

describe('combining selections', () => {
  const a = select(rect(0, 0, 200, 200))!;
  it('adds, subtracts and intersects', () => {
    const added = select(rect(100, 100, 200, 200), a, 'add');
    expect(area(added)).toBe(200 * 200 * 2 - 100 * 100);
    const subtracted = select(rect(100, 100, 200, 200), a, 'subtract');
    expect(area(subtracted)).toBe(200 * 200 - 100 * 100);
    const intersected = select(rect(100, 100, 200, 200), a, 'intersect');
    expect(area(intersected)).toBe(100 * 100);
    expect(select(rect(0, 0, 600, 400), a, 'subtract')).toBeNull(); // nothing left
    expect(select(rect(400, 300, 10, 10), a, 'intersect')).toBeNull();
  });

  it('combines with Select All and stays within the canvas', () => {
    const all = Selection.all().data;
    const hole = select(rect(-50, -50, 100, 100), all, 'subtract')!;
    expect(hole.fill).toBe(255);
    expect([at(hole, 10, 10), at(hole, 60, 60), at(hole, 599, 399), at(hole, 600, 10)]).toEqual([0, 255, 255, 0]);
    expect(area(select(rect(500, 300, 200, 200), all, 'intersect'))).toBe(100 * 100);
  });

  it('inverts', () => {
    const inv = invertSelection(a, canvas)!;
    expect(area(inv)).toBe(600 * 400 - 200 * 200);
    expect(invertSelection(Selection.all().data, canvas)).toBeNull();
    expect(invertSelection(inv, canvas)).not.toBeNull();
  });
});

describe('reading selections', () => {
  it('moved selections read at their new place; nothing is selected outside the canvas', () => {
    const moved = new Selection(select(rect(0, 0, 10, 10))!).moved(300, 5);
    expect([moved.value(300, 5, canvas), moved.value(309, 14, canvas), moved.value(5, 5, canvas)]).toEqual([
      255, 255, 0,
    ]);
    expect(moved.bounds(canvas)).toEqual({ x: 300, y: 5, w: 256, h: 256 });
    expect(new Selection(select(rect(590, 0, 10, 10))!).moved(5, 0).value(600, 5, canvas)).toBe(0);
  });

  it('aligns the mask to a layer tile, reporting uniform tiles cheaply', () => {
    const reader = new MaskReader(select(rect(100, 0, 100, 100))!);
    expect(reader.layerTile(canvas, 0, 0, 1, 1)).toBe(0); // no selection there
    const tile = reader.layerTile(canvas, -50, 0, 0, 0); // layer offset −50: layer x 150 is document x 100
    expect(tile).toBeInstanceOf(Uint8Array);
    const data = tile as Uint8Array;
    expect([data[149], data[150], data[249], data[250]]).toEqual([0, 255, 255, 0]);
    expect(new MaskReader(Selection.all().data).layerTile(canvas, 0, 0, 0, 0)).toBe(255);
  });

  it('detects empty masks', () => {
    expect(maskIsEmpty({ tiles: [], fill: 0, offsetX: 0, offsetY: 0 }, canvas)).toBe(true);
    expect(maskIsEmpty(Selection.all().data, canvas)).toBe(false);
    expect(maskIsEmpty(new Selection(select(rect(0, 0, 10, 10))!).moved(1000, 0).data, canvas)).toBe(true);
  });
});
