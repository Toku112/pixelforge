import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { AppController } from '../../src/app/controller';

type AppWindow = { __pixelforge: AppController };

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

async function stroke(page: Page, from: [number, number], to: [number, number]) {
  const a = await at(page, from[0], from[1]);
  const b = await at(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}

/** The active layer's pixels (RGBA, row by row). */
const pixels = (page: Page) =>
  page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    const doc = ws.active!.doc;
    const l = doc.activeLayer as { buffer: { getPixel(x: number, y: number): number[] } };
    const out: number[] = [];
    for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) out.push(...l.buffer.getPixel(x, y));
    return out;
  });

/** Whether the app has a Pencil tool. */
const hasPencil = (page: Page) =>
  page.evaluate(() => (window as unknown as AppWindow).__pixelforge.tools.byId.has('pencil'));

test('the Pencil shares B with the Brush and paints hard pixels only', async ({ page }) => {
  expect(await hasPencil(page)).toBe(true);
  await page.keyboard.press('b');
  await page.keyboard.press('Shift+B');
  await expect(page.getByRole('button', { name: 'Tool preset picker' })).toHaveAttribute('title', /Pencil Tool/);
  await page.keyboard.press('b'); // stays on the group's current tool
  await expect(page.getByRole('button', { name: 'Tool preset picker' })).toHaveAttribute('title', /Pencil Tool/);
  await expect(page.getByRole('textbox', { name: 'Flow:' })).toHaveCount(0); // the Pencil has no flow

  await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.tools.pencil.setOptions({ size: 5 }));
  await stroke(page, [10.3, 10.6], [80.7, 50.2]);
  const px = await pixels(page);
  let painted = 0;
  for (let i = 3; i < px.length; i += 4) {
    expect([0, 255]).toContain(px[i]);
    if (px[i] === 255) painted++;
  }
  expect(painted).toBeGreaterThan(300);
  const history = page.getByRole('listbox', { name: 'History states' }).getByRole('option');
  await expect(history.last()).toHaveText('Pencil');
});

test('Auto Erase: a stroke starting on the foreground colour paints the background colour', async ({ page }) => {
  await page.keyboard.press('b');
  await page.keyboard.press('Shift+B');
  await page.evaluate(() => {
    const c = (window as unknown as AppWindow).__pixelforge;
    c.colors.setForeground({ r: 1, g: 0, b: 0 });
    c.colors.setBackground({ r: 0, g: 0, b: 1 });
    c.tools.pencil.setOptions({ size: 3 });
  });
  await stroke(page, [10.5, 30.5], [60.5, 30.5]); // red line
  await page.getByRole('checkbox', { name: 'Auto Erase' }).check();
  await page.getByLabel('Document canvas').focus();
  await stroke(page, [30.5, 30.5], [30.5, 55.5]); // starts on red: paints blue
  await stroke(page, [80.5, 10.5], [80.5, 40.5]); // starts on nothing: paints red
  const px = await pixels(page);
  const rgb = (x: number, y: number) => px.slice((y * 96 + x) * 4, (y * 96 + x) * 4 + 3);
  expect(rgb(30, 50)).toEqual([0, 0, 255]);
  expect(rgb(80, 20)).toEqual([255, 0, 0]);
  expect(rgb(15, 30)).toEqual([255, 0, 0]);
});

test('Eraser modes: Pencil erases hard pixels; Block erases a fixed square on screen', async ({ page }) => {
  // An opaque layer to erase from.
  await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.execute({ name: 'fill', params: { color: [0, 128, 0] } });
  });
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('e');
  const mode = page.getByRole('combobox', { name: 'Eraser mode' });
  await expect(mode).toHaveValue('brush');
  await mode.selectOption('pencil');
  await page.evaluate(() =>
    (window as unknown as AppWindow).__pixelforge.tools.eraser.setOptions({ size: 7, hardness: 0 }),
  );
  await page.getByLabel('Document canvas').focus();
  await stroke(page, [10.2, 10.7], [40.6, 30.1]);
  let px = await pixels(page);
  let erased = 0;
  for (let i = 3; i < px.length; i += 4) {
    expect([0, 255]).toContain(px[i]);
    if (px[i] === 0) erased++;
  }
  expect(erased).toBeGreaterThan(100);

  // Block: 16 CSS px = 4 image px here, whatever the brush size; nothing else to set.
  await mode.selectOption('block');
  await expect(page.getByRole('button', { name: 'Brush preset picker' })).toHaveCount(0);
  await page.getByLabel('Document canvas').focus();
  const p = await at(page, 70, 45);
  await page.mouse.click(p.x, p.y);
  px = await pixels(page);
  const alpha = (x: number, y: number) => px[(y * 96 + x) * 4 + 3];
  for (const [x, y] of [
    [68, 43],
    [71, 46],
  ])
    expect(alpha(x!, y!), `${x}, ${y}`).toBe(0);
  for (const [x, y] of [
    [66, 45],
    [73, 45],
    [70, 41],
    [70, 48],
  ])
    expect(alpha(x!, y!), `${x}, ${y}`).toBe(255);
});
