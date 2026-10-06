import { expect, test, type Page } from '@playwright/test';

async function open(page: Page) {
  await page.goto('/tests/e2e/harness/viewport.html');
  await page.waitForFunction(() => window.__view !== undefined);
}
const state = (page: Page) => page.evaluate(() => window.__view!.state());
const docAt = (page: Page, x: number, y: number) => page.evaluate(([cx, cy]) => window.__view!.docAt(cx!, cy!), [x, y]);

test.beforeEach(async ({ page }) => open(page));

// Expectations are in device pixels: Playwright's desktop Safari profile uses a 2× display.
test('a new document is fitted and centred on screen, and drawn', async ({ page }) => {
  const s = await state(page);
  expect(s.zoom).toBeCloseTo(((600 - 32) * s.dpr) / 3000, 4); // height-limited fit with a 16 CSS px margin
  expect([s.centerX, s.centerY]).toEqual([2000, 1500]);
  expect(await page.evaluate(() => window.__view!.pixelAt(400, 300))).not.toEqual([40, 40, 40]); // not pasteboard
});

test('wheel scrolls the view; a fitted document does not move', async ({ page }) => {
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, 200);
  expect((await state(page)).centerY).toBe(1500); // fits on screen: stays centred
  await page.evaluate(() => window.__view!.actualPixels());
  const before = await state(page);
  await page.mouse.wheel(0, 120);
  await page.mouse.wheel(80, 0);
  // At 100 % one image pixel is one device pixel: the content moves 120 CSS px = 120·dpr image px.
  await expect.poll(async () => (await state(page)).centerY).toBeCloseTo(before.centerY + 120 * before.dpr, 3);
  expect((await state(page)).centerX).toBeCloseTo(before.centerX + 80 * before.dpr, 3);
});

test('Alt + wheel and pinch (Ctrl + wheel) zoom around the pointer', async ({ page }) => {
  await page.evaluate(() => window.__view!.actualPixels());
  for (const modifier of ['Alt', 'Control']) {
    const z0 = (await state(page)).zoom;
    const anchor = await docAt(page, 250, 180);
    await page.mouse.move(250, 180);
    await page.keyboard.down(modifier);
    await page.mouse.wheel(0, -100); // zoom in
    await page.keyboard.up(modifier);
    await expect.poll(async () => (await state(page)).zoom).toBeGreaterThan(z0);
    const after = await docAt(page, 250, 180);
    expect(after.x).toBeCloseTo(anchor.x, 1);
    expect(after.y).toBeCloseTo(anchor.y, 1);
  }
});

test('holding Space temporarily pans with the Hand tool, whatever tool is active', async ({ page }) => {
  await page.evaluate(() => window.__view!.setTool('zoom'));
  await page.evaluate(() => window.__view!.actualPixels());
  const start = await docAt(page, 300, 300);
  await page.mouse.move(300, 300);
  await page.keyboard.down('Space');
  expect(await page.evaluate(() => window.__view!.cursor())).toBe('grab');
  await page.mouse.down();
  await page.mouse.move(360, 250, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const moved = await docAt(page, 360, 250);
  expect(moved.x).toBeCloseTo(start.x, 3);
  expect(moved.y).toBeCloseTo(start.y, 3);
  expect(await page.evaluate(() => window.__view!.cursor())).toBe('zoom-in'); // back to the Zoom tool
});

test('Zoom tool: click zooms in, Alt-click zooms out, scrubby drag zooms continuously', async ({ page }) => {
  await page.evaluate(() => window.__view!.setTool('zoom'));
  await page.evaluate(() => window.__view!.actualPixels());
  await page.mouse.click(200, 200);
  expect((await state(page)).zoom).toBe(2);
  await page.keyboard.down('Alt');
  await page.mouse.click(200, 200);
  await page.keyboard.up('Alt');
  expect((await state(page)).zoom).toBe(1);
  await page.mouse.move(300, 300);
  await page.mouse.down();
  await page.mouse.move(375, 300, { steps: 10 }); // +75 CSS px → ×√2 (rate is per CSS pixel)
  await page.mouse.up();
  expect((await state(page)).zoom).toBeCloseTo(Math.SQRT2, 2);
});

test('Zoom tool with Scrubby Zoom off zooms to a dragged rectangle', async ({ page }) => {
  await page.evaluate(() => window.__view!.setTool('zoom', { scrubby: false }));
  await page.evaluate(() => window.__view!.actualPixels());
  await page.mouse.move(100, 100);
  await page.mouse.down();
  await page.mouse.move(300, 250, { steps: 5 });
  expect(await page.evaluate(() => window.__view!.overlayVisible())).toBe(true);
  await page.mouse.up();
  expect(await page.evaluate(() => window.__view!.overlayVisible())).toBe(false);
  expect((await state(page)).zoom).toBeCloseTo(4, 3); // 800/200 = 600/150
});

test('Rotate View tool rotates with the drag; Shift snaps to 15°', async ({ page }) => {
  await page.evaluate(() => window.__view!.setTool('rotate-view'));
  await page.mouse.move(600, 300); // right of centre (400, 300)
  await page.mouse.down();
  await page.mouse.move(400, 500, { steps: 8 }); // below centre → 90°
  expect((await state(page)).rotation).toBeCloseTo(90, 0);
  await page.keyboard.down('Shift');
  await page.mouse.move(600, 357, { steps: 4 }); // ≈ 16° → snaps to 15°
  await page.keyboard.up('Shift');
  await page.mouse.up();
  expect((await state(page)).rotation).toBe(15);
});

test('Escape abandons a rotation in progress', async ({ page }) => {
  await page.evaluate(() => window.__view!.setTool('rotate-view'));
  await page.mouse.move(600, 300);
  await page.mouse.down();
  await page.mouse.move(400, 500, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await state(page)).rotation).toBe(0);
});

test.describe('high-density display', () => {
  test.use({ deviceScaleFactor: 2 });

  test('the drawing buffer uses device pixels and 100 % is one image pixel per device pixel', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'firefox', 'Playwright cannot emulate device scale factors in Firefox');
    await page.evaluate(() => window.__view!.actualPixels());
    const s = await state(page);
    expect(s.dpr).toBe(2);
    expect(s.canvasWidth).toBe(1600);
    expect(s.zoom).toBe(1);
    // 100 CSS px = 200 device px = 200 image pixels.
    const a = await docAt(page, 100, 100);
    const b = await docAt(page, 200, 100);
    expect(b.x - a.x).toBeCloseTo(200, 6);
  });
});
