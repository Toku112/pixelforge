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

async function drag(page: Page, from: [number, number], to: [number, number], modifiers: 'Alt'[] = []) {
  const a = await at(page, from[0], from[1]);
  const b = await at(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.down();
  for (const m of modifiers) await page.keyboard.up(m);
  await page.mouse.move(b.x, b.y, { steps: 20 });
  await page.mouse.up();
}

/** The active layer's pixel. */
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
const toolTitle = (page: Page) => page.getByRole('button', { name: 'Tool preset picker' });

/** Brushes of 10 px for the History Brush and the Eraser, so strokes stay apart on the small image. */
async function smallBrushes(page: Page) {
  await page.evaluate(() => {
    const t = (window as unknown as AppWindow).__pixelforge.tools;
    t.historyBrush.setOptions({ size: 10 });
    t.eraser.setOptions({ size: 10 });
  });
}

/** Fills the Background white (Edit > Fill), so the History Brush has something to bring back. */
async function fillWhite(page: Page) {
  await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.execute({ name: 'fill', params: { color: [255, 255, 255] } });
  });
  await expect(history(page).last()).toHaveText('Fill');
  await canvas(page).focus();
}

test('Y paints the opened image back; the source column picks another state', async ({ page }) => {
  const original = await pixel(page, 48, 32);
  const left = await pixel(page, 30, 32);
  expect(original).not.toEqual([255, 255, 255]);
  await smallBrushes(page);
  await fillWhite(page);
  await page.keyboard.press('y');
  await expect(toolTitle(page)).toHaveAttribute('title', /History Brush Tool/);
  await expect(page.getByRole('radio', { name: 'History Brush source: Open' })).toBeChecked();
  await drag(page, [20, 32], [76, 32]);
  await expect(history(page).last()).toHaveText('History Brush');
  expect(await pixel(page, 48, 32)).toEqual(original);
  expect(await pixel(page, 48, 2)).toEqual([255, 255, 255]);

  // The Fill state as the source: painting brings the white back.
  await page.getByRole('radio', { name: 'History Brush source: Fill' }).click();
  await expect(page.getByRole('radio', { name: 'History Brush source: Fill' })).toBeChecked();
  await canvas(page).focus();
  await drag(page, [48, 10], [48, 54]);
  await expect(history(page)).toHaveCount(4);
  expect(await pixel(page, 48, 32)).toEqual([255, 255, 255]);
  expect(await pixel(page, 30, 32)).toEqual(left);
  await page.keyboard.press('ControlOrMeta+Z');
  expect(await pixel(page, 48, 32)).toEqual(original);

  // Going back to before the source state and painting drops it: the opening state is the source again.
  await page.getByRole('option', { name: 'Open' }).click();
  await canvas(page).focus();
  await drag(page, [20, 10], [76, 10]);
  await expect(history(page)).toHaveCount(2);
  await expect(page.getByRole('radio', { name: 'History Brush source: Open' })).toBeChecked();
});

test('Shift+Y is the Art History Brush: strokes in the source colours, with style, area and tolerance', async ({
  page,
}) => {
  await fillWhite(page);
  await page.keyboard.press('y');
  await page.keyboard.press('Shift+Y');
  await expect(toolTitle(page)).toHaveAttribute('title', /Art History Brush Tool/);
  await page.getByRole('combobox', { name: 'Art History Brush style' }).selectOption('dab');
  await page.getByRole('textbox', { name: 'Area:' }).fill('20');
  await page.getByRole('textbox', { name: 'Area:' }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Tolerance:' })).toHaveValue('0%');
  await canvas(page).focus();
  await drag(page, [20, 32], [76, 32]);
  await expect(history(page).last()).toHaveText('Art History Brush');
  const painted = await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    const l = ws.active!.doc.activeLayer as { buffer: { getPixel(x: number, y: number): number[] } };
    let n = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) if (l.buffer.getPixel(x, y).join() !== '255,255,255') n++;
    return n;
  });
  expect(painted).toBeGreaterThan(100);
  const recorded = await page.evaluate(() => {
    const h = (window as unknown as AppWindow).__pixelforge.workspace.active!.history;
    return h.descriptorOf(h.entries.at(-1)!.id)?.params['art'];
  });
  expect(recorded).toEqual({ style: 'dab', area: 20, tolerance: 0 });
});

test('the Eraser erases to history: with the option, or with Alt for one stroke', async ({ page }) => {
  const original = await pixel(page, 48, 20);
  const lower = await pixel(page, 48, 44);
  await smallBrushes(page);
  await fillWhite(page);
  await page.keyboard.press('e');
  await drag(page, [20, 20], [76, 20], ['Alt']);
  await expect(history(page).last()).toHaveText('Eraser');
  expect(await pixel(page, 48, 20)).toEqual(original);

  await page.getByRole('checkbox', { name: 'Erase to History' }).check();
  await canvas(page).focus();
  await drag(page, [20, 44], [76, 44]);
  await expect(history(page)).toHaveCount(4);
  expect(await pixel(page, 48, 44)).toEqual(lower);
  // With the option on, Alt erases as usual (to the background colour on the Background).
  await drag(page, [20, 56], [76, 56], ['Alt']);
  await expect(history(page)).toHaveCount(5);
  expect(await pixel(page, 48, 56)).toEqual([255, 255, 255]);
});

test('Edit > Fill with History, and the warning for a layer the source does not have', async ({ page }) => {
  const original = await pixel(page, 10, 10);
  await fillWhite(page);
  await page.keyboard.press('Shift+F5');
  await page.getByRole('combobox', { name: 'Contents' }).selectOption('history');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(history(page).last()).toHaveText('Fill');
  await expect(history(page)).toHaveCount(3);
  expect(await pixel(page, 10, 10)).toEqual(original);

  await page.keyboard.press('ControlOrMeta+Alt+Shift+N'); // a new, empty layer
  await expect(history(page).last()).toHaveText('New Layer');
  await smallBrushes(page);
  await page.keyboard.press('y');
  await drag(page, [20, 32], [76, 32]);
  const alert = page.getByRole('dialog', { name: 'Could not use the History Brush' });
  await expect(alert).toContainText('does not have this layer');
  await alert.getByRole('button', { name: 'OK' }).click();
  await expect(history(page).last()).toHaveText('New Layer');

  // The current state as the source: painting the new layer works.
  await page.getByRole('radio', { name: 'History Brush source: New Layer' }).click();
  await canvas(page).focus();
  await drag(page, [20, 32], [76, 32]);
  await expect(history(page).last()).toHaveText('History Brush');
});
