import { expect, test } from '@playwright/test';

// Exit criterion (CLAUDE.md §3.4): ≥ 60 fps while panning/zooming a 50-layer 8000×6000 document.
// Runs on the real GPU (`pnpm test:perf`); CI's software GPU cannot measure this.
test('pan, zoom and rotate a 50-layer 8000×6000 document at 60 fps', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/tests/e2e/harness/perf.html');
  await page.waitForFunction(() => window.__perf !== undefined);
  const r = await page.evaluate(() => window.__perf!.run());
  console.log(JSON.stringify(r, null, 2));
  expect(r.layers).toBe(50);
  for (const phase of [r.pan, r.zoomIn, r.zoomOut, r.rotate]) {
    expect(phase.cpuP95).toBeLessThan(12); // main-thread work per frame
    expect(phase.intervalP50).toBeLessThan(17.5); // 60 fps typical
    expect(phase.intervalP95).toBeLessThan(25);
  }
});
