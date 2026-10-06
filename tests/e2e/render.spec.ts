import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/tests/e2e/harness/render.html');
  await page.waitForFunction(() => window.__render !== undefined);
});

test.describe('GPU composite matches the CPU reference compositor', () => {
  for (const scene of ['layers8', 'layers16', 'gray8', 'transparent']) {
    test(scene, async ({ page }) => {
      const r = await page.evaluate((s) => window.__render!.compareComposite(s), scene);
      expect(r.floatTargets).toBe(true);
      // Half-float composite targets: a few roundings of ≈0.0005 each accumulate over the
      // blends. 0.0025 is still below 0.65 of one 8-bit step.
      expect(r.maxDiff).toBeLessThan(2.5e-3);
    });
  }

  test('hdr32 (values above 1.0)', async ({ page }) => {
    const r = await page.evaluate(() => window.__render!.compareComposite('hdr32'));
    expect(r.maxRel).toBeLessThan(3e-3);
  });
});

test.describe('display', () => {
  test('100 %: every canvas pixel equals the composite over the checkerboard', async ({ page }) => {
    const r = await page.evaluate(() =>
      window.__render!.compareDisplay('layers8', { zoom: 1, rotation: 0, centerX: 300, centerY: 150 }),
    );
    expect(r.checked).toBeGreaterThan(150_000);
    expect(r.maxDiff, JSON.stringify(r.at)).toBeLessThanOrEqual(1);
  });

  test('rotated 90°', async ({ page }) => {
    const r = await page.evaluate(() =>
      window.__render!.compareDisplay('layers8', { zoom: 1, rotation: 90, centerX: 300, centerY: 150 }),
    );
    expect(r.maxDiff, JSON.stringify(r.at)).toBeLessThanOrEqual(1);
  });

  test('25 % uses the pyramid (4×4 box average)', async ({ page }) => {
    const r = await page.evaluate(() =>
      window.__render!.compareDisplay('pattern', { zoom: 0.25, rotation: 0, centerX: 1024, centerY: 512 }),
    );
    expect(r.maxDiff, JSON.stringify(r.at)).toBeLessThanOrEqual(2);
  });

  test('32-bit documents are shown sRGB-encoded', async ({ page }) => {
    const r = await page.evaluate(() =>
      window.__render!.compareDisplay('hdr32', { zoom: 1, rotation: 0, centerX: 150, centerY: 100 }),
    );
    expect(r.maxDiff, JSON.stringify(r.at)).toBeLessThanOrEqual(2);
  });

  test('16-bit and grayscale documents display correctly', async ({ page }) => {
    for (const scene of ['layers16', 'gray8']) {
      const r = await page.evaluate(
        (s) => window.__render!.compareDisplay(s, { zoom: 2, rotation: 0, centerX: 300, centerY: 150 }),
        scene,
      );
      expect(r.maxDiff, `${scene} ${JSON.stringify(r.at)}`).toBeLessThanOrEqual(1);
    }
  });

  test('pixel grid lines are one device pixel wide, every document pixel, at 800 %', async ({ page }) => {
    const r = await page.evaluate(() => window.__render!.gridLines());
    // 64 device pixels at 8 px per document pixel → 8 one-pixel lines in each direction.
    expect(r).toEqual({ lineColumns: 8, lineRows: 8, onLine: true });
  });
});

test('editing a layer recomposites only the affected tiles', async ({ page }) => {
  const r = await page.evaluate(() => window.__render!.incrementalUpdate());
  expect(r.recomposited).toBeGreaterThan(0);
  expect(r.recomposited).toBeLessThan(r.totalTiles);
});
