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
  await page.evaluate(async () => {
    const c = (window as unknown as AppWindow).__pixelforge;
    await c.services.patterns.ready;
    const ctx = c.canvas!.context;
    ctx.viewport.zoomTo(4 * c.canvas!.renderer.devicePixelRatio); // 4 CSS px per image px
    ctx.viewport.centerX = 48;
    ctx.viewport.centerY = 32;
    ctx.viewChanged();
  });
  await page.keyboard.press('ControlOrMeta+Alt+Shift+N'); // a new, empty layer
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

async function click(page: Page, x: number, y: number, modifiers: ('Alt' | 'Shift')[] = []) {
  const p = await at(page, x, y);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(p.x, p.y);
  for (const m of modifiers) await page.keyboard.up(m);
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  const a = await at(page, from[0], from[1]);
  const b = await at(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

/** The active layer's pixel (RGBA). */
const pixel = (page: Page, x: number, y: number) =>
  page.evaluate(
    async ([px, py]) => {
      const ws = (window as unknown as AppWindow).__pixelforge.workspace;
      await ws.whenIdle();
      const l = ws.active!.doc.activeLayer as { buffer: { getPixel(x: number, y: number): number[] } };
      return l.buffer.getPixel(px!, py!);
    },
    [x, y],
  );

const history = (page: Page) => page.getByRole('listbox', { name: 'History states' }).getByRole('option');
const canvas = (page: Page) => page.getByLabel('Document canvas');

/** A black wall down columns 40–41 of the empty layer (marquee, then Alt+Backspace fills it with the foreground). */
async function wall(page: Page) {
  await page.keyboard.press('m');
  await drag(page, [40, 0], [42, 64]);
  await expect(history(page).last()).toHaveText('Rectangular Marquee');
  await page.keyboard.press('Alt+Backspace');
  await expect(history(page).last()).toHaveText('Fill');
  await page.keyboard.press('ControlOrMeta+D');
  await expect(history(page).last()).toHaveText('Deselect');
  expect(await pixel(page, 40, 30)).toEqual([0, 0, 0, 255]);
}

test('Shift+G reaches the Paint Bucket; a click fills what joins it, as one History step', async ({ page }) => {
  await wall(page);
  await page.keyboard.press('g');
  await page.keyboard.press('Shift+G');
  await expect(page.getByRole('button', { name: 'Tool preset picker' })).toHaveAttribute('title', /Paint Bucket Tool/);
  await page.keyboard.press('x'); // white foreground
  await click(page, 10.5, 10.5);
  await expect(history(page).last()).toHaveText('Paint Bucket');
  expect(await pixel(page, 0, 0)).toEqual([255, 255, 255, 255]);
  expect(await pixel(page, 39, 63)).toEqual([255, 255, 255, 255]);
  expect(await pixel(page, 41, 30)).toEqual([0, 0, 0, 255]); // the wall
  expect(await pixel(page, 70, 10)).toEqual([0, 0, 0, 0]); // beyond it

  // Not Contiguous: every pixel like the clicked one, on both sides of the wall.
  await page.keyboard.press('ControlOrMeta+Z');
  await page.getByRole('checkbox', { name: 'Contiguous' }).uncheck();
  await canvas(page).focus();
  await click(page, 10.5, 10.5);
  expect(await pixel(page, 70, 10)).toEqual([255, 255, 255, 255]);
  expect(await pixel(page, 41, 30)).toEqual([0, 0, 0, 255]);

  // Opacity from the number keys, Tolerance typed; the mode list offers Behind on a layer.
  await page.keyboard.press('5');
  await expect(page.getByRole('textbox', { name: 'Opacity:' })).toHaveValue('50%');
  await page.getByRole('textbox', { name: 'Tolerance:' }).fill('0');
  await page.getByRole('textbox', { name: 'Tolerance:' }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Tolerance:' })).toHaveValue('0');
  await expect(
    page.getByRole('combobox', { name: 'Paint Bucket mode' }).locator('option[value="behind"]'),
  ).toBeEnabled();
});

test('fills with a pattern, inside the selection; Alt-click picks up a colour', async ({ page }) => {
  await wall(page);
  await page.keyboard.press('g');
  await page.keyboard.press('Shift+G');
  const picker = page.getByRole('button', { name: 'Paint Bucket pattern' });
  await expect(picker).toBeDisabled();
  await page.getByRole('combobox', { name: 'Fill with' }).selectOption('pattern');
  await expect(picker).toBeEnabled();
  await picker.click();
  await page.getByRole('option', { name: 'Dots' }).click();
  await canvas(page).focus();

  // A selection on the right: the fill stays inside it, and a click outside it does nothing.
  await page.keyboard.press('m');
  await drag(page, [60, 10], [90, 50]);
  await expect(history(page).last()).toHaveText('Rectangular Marquee');
  await page.keyboard.press('g'); // back from the marquee: G remembers the Paint Bucket
  await click(page, 20.5, 20.5);
  await expect(history(page).last()).not.toHaveText('Paint Bucket');
  await click(page, 70.5, 20.5);
  await expect(history(page).last()).toHaveText('Paint Bucket');
  const inside = await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    const l = ws.active!.doc.activeLayer as { buffer: { getPixel(x: number, y: number): number[] } };
    const seen = new Set<string>();
    for (let y = 10; y < 50; y++) for (let x = 60; x < 90; x++) seen.add(l.buffer.getPixel(x, y).join());
    return seen.size;
  });
  expect(inside).toBeGreaterThan(1); // the dots, not one colour
  expect(await pixel(page, 70, 5)).toEqual([0, 0, 0, 0]);
  expect(await pixel(page, 95, 20)).toEqual([0, 0, 0, 0]);

  // Alt-click on the wall: the foreground becomes black (from white after X).
  await page.keyboard.press('ControlOrMeta+D');
  await page.keyboard.press('x');
  await click(page, 40.5, 30.5, ['Alt']);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as AppWindow).__pixelforge.colors.foreground))
    .toEqual({ r: 0, g: 0, b: 0 });
});
