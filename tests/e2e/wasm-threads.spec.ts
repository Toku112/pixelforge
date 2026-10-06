import { expect, test } from '@playwright/test';

test('pixel worker runs the multi-threaded SIMD WebAssembly build', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/tests/e2e/harness/wasm.html');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.waitForFunction(() => window.__harness !== undefined);

  const info = await page.evaluate(() => window.__harness!.info());
  expect(info).toMatchObject({ variant: 'mt', simd: true, threads: true, crossOriginIsolated: true });
  expect(info.threadCount).toBeGreaterThan(1);

  // 24 megapixels (a 6000×4000 photo) through the thread pool.
  const result = await page.evaluate(() => window.__harness!.invertPattern(6000 * 4000));
  expect(result.length).toBe(6000 * 4000 * 4);
  expect(result.mismatches).toBe(0);
  expect(errors).toEqual([]);
});

test('pixel worker falls back to the single-threaded SIMD build', async ({ page }) => {
  await page.goto('/tests/e2e/harness/wasm.html');
  await page.waitForFunction(() => window.__harness !== undefined);

  const info = await page.evaluate(() => window.__harness!.info('st'));
  expect(info).toMatchObject({ variant: 'st', simd: true, threads: false, threadCount: 1 });

  const result = await page.evaluate(() => window.__harness!.invertPattern(1000 * 1000, 'st'));
  expect(result.mismatches).toBe(0);
});

test('worker PixelOps writes results into heap and shared-memory tiles', async ({ page }) => {
  await page.goto('/tests/e2e/harness/wasm.html');
  await page.waitForFunction(() => window.__harness !== undefined);
  const result = await page.evaluate(() => window.__harness!.pixelOpsInvert());
  expect(result).toEqual({ heap: [245, 245, 245, 10], shared: [235, 235, 235, 20], heapLength: 256 * 256 * 4 });
});
