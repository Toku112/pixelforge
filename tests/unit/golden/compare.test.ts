import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareImages } from '../../golden/lib/compare';
import { expectGolden } from '../../golden/lib/golden';
import { createImage, fillImage, type RgbaImage } from '../../golden/lib/image';
import { readPng, writePng } from '../../golden/lib/png';

const gradient = (depth: 8 | 16 | 32) => fillImage(createImage(32, 16, depth), (x, y) => [x / 31, y / 15, 0.5, 1]);

function clone(img: RgbaImage): RgbaImage {
  return { ...img, data: img.data.slice() };
}

describe('compareImages', () => {
  it('reports zero difference for identical images', () => {
    const img = gradient(8);
    const r = compareImages(img, clone(img));
    expect(r).toMatchObject({ pass: true, avgDeltaE: 0, maxDeltaE: 0, failingPixels: 0 });
  });

  it('tolerates a one-code-value change in 8-bit', () => {
    const a = gradient(8);
    const b = clone(a);
    for (let i = 0; i < b.data.length; i += 4) b.data[i] = Math.min(255, b.data[i]! + 1);
    const r = compareImages(a, b);
    expect(r.pass).toBe(true);
    expect(r.maxDeltaE).toBeGreaterThan(0);
    expect(r.maxDeltaE).toBeLessThan(1);
  });

  it('locates and flags a clearly different pixel', () => {
    const a = gradient(8);
    const b = clone(a);
    const i = (5 * 32 + 7) * 4;
    b.data[i] = 255;
    b.data[i + 1] = 0;
    b.data[i + 2] = 255;
    const r = compareImages(b, a);
    expect(r.pass).toBe(false);
    expect(r.maxAt).toEqual({ x: 7, y: 5 });
    expect(r.failingPixels).toBe(1);
    expect([...r.diff.data.slice(i, i + 4)]).toEqual([255, 0, 255, 255]); // magenta marks failures
  });

  it('ignores colour under fully transparent pixels but catches alpha changes', () => {
    const a = fillImage(createImage(4, 4, 8), () => [1, 0, 0, 0]);
    const b = fillImage(createImage(4, 4, 8), () => [0, 0, 1, 0]);
    expect(compareImages(a, b).maxDeltaE).toBe(0);

    const c = fillImage(createImage(4, 4, 8), () => [1, 0, 0, 0.5]);
    expect(compareImages(a, c).pass).toBe(false);
  });

  it('compares across bit depths', () => {
    const r16 = compareImages(gradient(16), gradient(8));
    expect(r16.maxDeltaE).toBeLessThan(0.5);
    // 32-bit images are linear light: build the same gradient in linear values.
    const lin = fillImage(createImage(32, 16, 32), (x, y) => [
      ((x / 31 + 0.055) / 1.055) ** 2.4,
      ((y / 15 + 0.055) / 1.055) ** 2.4,
      0.214041,
      1,
    ]);
    expect(compareImages(lin, gradient(16)).maxDeltaE).toBeLessThan(0.5);
  });

  it('applies custom tolerances', () => {
    const a = gradient(8);
    const b = clone(a);
    // +3 code values in red: max ΔE00 ≈ 1.7, average ≈ 0.57.
    for (let i = 0; i < b.data.length; i += 4) b.data[i] = Math.min(255, b.data[i]! + 3);
    expect(compareImages(a, b).pass).toBe(true);
    expect(compareImages(a, b, { maxDeltaE: 1 }).pass).toBe(false);
    expect(compareImages(a, b, { avgDeltaE: 0.5 }).pass).toBe(false);
  });

  it('rejects images of different sizes', () => {
    expect(() => compareImages(createImage(2, 2, 8), createImage(2, 3, 8))).toThrow('Image size mismatch');
  });
});

describe('PNG round trip', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it.each([8, 16] as const)('preserves %i-bit RGBA samples exactly', (depth) => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-png-'));
    dirs.push(dir);
    const img = fillImage(createImage(7, 5, depth), (x, y) => [x / 6, y / 4, (x * y) / 24, (x + y) / 10]);
    writePng(join(dir, 'a.png'), img);
    const back = readPng(join(dir, 'a.png'));
    expect(back.depth).toBe(depth);
    expect([...back.data]).toEqual([...img.data]);
  });
});

describe('expectGolden', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tempRoot = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-golden-'));
    dirs.push(dir);
    return dir;
  };

  it('asks for an update when the expected image is missing', () => {
    expect(() => expectGolden('feat', 'case', gradient(8), { root: tempRoot(), update: false })).toThrow(
      'pnpm test:golden:update',
    );
  });

  it('writes expected images in update mode, then passes against them', () => {
    const root = tempRoot();
    expect(expectGolden('feat', 'case', gradient(8), { root, update: true })).toBeNull();
    expect(existsSync(join(root, 'feat', 'case.expected.png'))).toBe(true);
    expect(expectGolden('feat', 'case', gradient(8), { root, update: false })?.pass).toBe(true);
  });

  it('writes actual and diff images when the comparison fails', () => {
    const root = tempRoot();
    expectGolden('feat', 'case', gradient(8), { root, update: true });
    const changed = fillImage(createImage(32, 16, 8), () => [1, 0, 0, 1]);
    expect(() => expectGolden('feat', 'case', changed, { root, update: false })).toThrow(/Golden mismatch.*max ΔE00/);
    expect(existsSync(join(root, '__output__', 'feat', 'case.actual.png'))).toBe(true);
    expect(existsSync(join(root, '__output__', 'feat', 'case.diff.png'))).toBe(true);
  });
});
