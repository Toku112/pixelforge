import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { AppController } from '../../src/app/controller';

type AppWindow = { __pixelforge: AppController };
type Smoothing = {
  amount: number;
  pulledString: boolean;
  catchUp: boolean;
  catchUpOnEnd: boolean;
  adjustForZoom: boolean;
  curves: boolean;
};

const FIXTURES = join(import.meta.dirname, '../fixtures/images');
const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    Object.assign(window, { showOpenFilePicker: undefined, showSaveFilePicker: undefined });
  });
  await page.goto('/');
  await page.getByTestId('app-root').waitFor();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+O');
  await (await chooser).setFiles(join(FIXTURES, 'photo.jpg')); // 96 × 64
  await expect(page.getByRole('tab', { name: /photo\.jpg/ })).toBeVisible();
  await page.evaluate(() => {
    const c = (window as unknown as AppWindow).__pixelforge;
    const ctx = c.canvas!.context;
    ctx.viewport.zoomTo(4 * c.canvas!.renderer.devicePixelRatio); // 4 CSS px per image px
    ctx.viewport.centerX = 48;
    ctx.viewport.centerY = 32;
    ctx.viewChanged();
  });
  await page.keyboard.press('ControlOrMeta+Alt+Shift+N');
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('b');
  // A small hard brush, so where the paint went is easy to see.
  await page.evaluate(() => {
    const brush = (window as unknown as AppWindow).__pixelforge.tools.byId.get('brush') as unknown as {
      setOptions(o: object): void;
    };
    brush.setOptions({ size: 3, hardness: 1 });
  });
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

async function at(page: Page, x: number, y: number) {
  const box = (await page.getByLabel('Document canvas').boundingBox())!;
  const p = await page.evaluate(
    ([dx, dy]) => {
      const c = (window as unknown as AppWindow).__pixelforge.canvas!;
      const v = c.context.viewport.docToView({ x: dx!, y: dy! });
      return { x: v.x / c.renderer.devicePixelRatio, y: v.y / c.renderer.devicePixelRatio };
    },
    [x, y],
  );
  return { x: box.x + p.x, y: box.y + p.y };
}

const setSmoothing = (page: Page, o: Partial<Smoothing>) =>
  page.evaluate((changes) => {
    const brush = (window as unknown as AppWindow).__pixelforge.tools.byId.get('brush') as unknown as {
      setSmoothing(o: object): void;
    };
    brush.setSmoothing(changes);
  }, o);

/** Alpha of every pixel of the active layer, row by row. */
const alphas = (page: Page) =>
  page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    const doc = ws.active!.doc;
    const l = doc.activeLayer as { buffer: { getPixel(x: number, y: number): number[] } };
    const out: number[] = [];
    for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) out.push(l.buffer.getPixel(x, y)[3]!);
    return out;
  });

const painted = (a: number[], x: number, y: number) => a[y * 96 + x]! > 128;

/** Rows with paint in columns x0…x1. */
function rowsCovered(a: number[], x0: number, x1: number): number {
  let n = 0;
  for (let y = 0; y < 64; y++) {
    let any = false;
    for (let x = x0; x <= x1; x++) any ||= painted(a, x, y);
    if (any) n++;
  }
  return n;
}

/** A shaky stroke along y = 32 from x = 10 to 86 (4 px up and down every 4 px). */
async function shakyStroke(page: Page) {
  const start = await at(page, 10, 32);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 19; i++) {
    const p = await at(page, 10 + i * 4, 32 + (i % 2 === 0 ? -4 : 4));
    await page.mouse.move(p.x, p.y, { steps: 3 });
  }
  await page.mouse.up();
}

test('the options bar: Smoothing 10 % with its options; the Brush Settings Smoothing draws curves', async ({
  page,
}) => {
  await expect(page.getByRole('textbox', { name: 'Smoothing:' })).toHaveValue('10%');
  await page.getByRole('button', { name: 'Smoothing options' }).click();
  const options = page.getByRole('group', { name: 'Smoothing options' });
  await expect(options.getByRole('checkbox', { name: 'Pulled String Mode' })).not.toBeChecked();
  await expect(options.getByRole('checkbox', { name: 'Stroke Catch-up' })).toBeChecked();
  await expect(options.getByRole('checkbox', { name: 'Catch-up on Stroke End' })).not.toBeChecked();
  await expect(options.getByRole('checkbox', { name: 'Adjust for Zoom' })).toBeChecked();
  await options.getByRole('checkbox', { name: 'Pulled String Mode' }).check();
  await page.keyboard.press('Escape');
  await expect(options).toHaveCount(0);
  const s = await page.evaluate(
    () => (window as unknown as AppWindow).__pixelforge.tools.byId.get('brush') as unknown as { smoothing: Smoothing },
  );
  expect(s.smoothing.pulledString).toBe(true);

  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('F5');
  const curves = page.locator('.brush-settings').getByRole('checkbox', { name: 'Smoothing' });
  await expect(curves).toBeChecked();
  await curves.uncheck();
  const after = await page.evaluate(
    () => (window as unknown as AppWindow).__pixelforge.tools.byId.get('brush') as unknown as { smoothing: Smoothing },
  );
  expect(after.smoothing.curves).toBe(false);
});

test('smoothing takes the shake out of a stroke', async ({ page }) => {
  await setSmoothing(page, { amount: 0, curves: false });
  await shakyStroke(page);
  const raw = rowsCovered(await alphas(page), 30, 60);
  await page.keyboard.press('ControlOrMeta+Z');
  // Pulled String Mode depends only on distances, so the result does not depend on the machine's speed.
  await setSmoothing(page, { amount: 0.5, pulledString: true, catchUpOnEnd: true });
  await shakyStroke(page);
  const smooth = rowsCovered(await alphas(page), 30, 60);
  expect(raw).toBeGreaterThanOrEqual(10); // 8 px of shake + the 3 px brush
  expect(smooth).toBeLessThan(raw - 3);
});

test('pulled string leaves no mark within reach; catch-up on stroke end reaches the pointer', async ({ page }) => {
  // 50 %: a string of 30 CSS px = 7.5 image px at this zoom.
  await setSmoothing(page, { amount: 0.5, pulledString: true, curves: false });
  const a = await at(page, 20, 20);
  const b = await at(page, 25, 20);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  let px = await alphas(page);
  expect(painted(px, 20, 20)).toBe(true); // the press itself
  expect(painted(px, 24, 20)).toBe(false); // the move stayed within reach
  // Farther: the paint trails by the string; with Catch-up on Stroke End it is finished at the pointer.
  await setSmoothing(page, { catchUpOnEnd: true });
  const c = await at(page, 20, 40);
  const d = await at(page, 60, 40);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(d.x, d.y, { steps: 10 });
  await page.mouse.up();
  px = await alphas(page);
  expect(painted(px, 40, 40)).toBe(true);
  expect(painted(px, 60, 40)).toBe(true);
});

test('stroke catch-up: resting on the pointer lets the paint arrive', async ({ page }) => {
  // (Without catch-up the paint stops behind: unit-tested, as it depends on timing.)
  await setSmoothing(page, { amount: 0.5, curves: false });
  const a = await at(page, 20, 20);
  const b = await at(page, 60, 20);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.waitForTimeout(500); // rest (the drift's time constant is 75 ms)
  await page.mouse.up();
  const px = await alphas(page);
  expect(painted(px, 40, 20)).toBe(true);
  expect(painted(px, 60, 20)).toBe(true);
});
