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
  await (await chooser).setFiles(join(FIXTURES, 'photo.jpg'));
  await expect(page.getByRole('tab', { name: /photo\.jpg/ })).toBeVisible();
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

const history = (page: Page) => page.getByRole('listbox', { name: 'History states' }).getByRole('option');

/** Pixel of the active layer once commands have finished. */
const pixel = (page: Page, x: number, y: number) =>
  page.evaluate(
    async ([px, py]) => {
      const ws = (window as unknown as AppWindow).__pixelforge.workspace;
      await ws.whenIdle();
      const layer = ws.active!.doc.activeLayer as { buffer: { getPixel(x: number, y: number): number[] } };
      return layer.buffer.getPixel(px!, py!);
    },
    [x, y],
  );

test('Edit > Fill with a picked colour (the Color Picker opens over Fill), mode and opacity', async ({ page }) => {
  await page.keyboard.press('Shift+F5');
  const fill = page.getByRole('dialog', { name: 'Fill' });
  await fill.getByLabel('Contents').selectOption('color');
  const picker = page.getByRole('dialog', { name: 'Color Picker (Fill Color)' });
  const hex = picker.getByRole('textbox', { name: 'Hexadecimal colour' });
  // Escape closes only the picker; Fill stays open with its previous choice.
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(fill).toBeVisible();
  await expect(fill.getByLabel('Contents')).toHaveValue('foreground');
  await fill.getByLabel('Contents').selectOption('color');
  await hex.fill('0000FF');
  await hex.press('Enter');
  await picker.getByRole('button', { name: 'OK' }).click();
  await expect(fill.getByLabel('Contents')).toHaveValue('color');
  await fill.getByLabel('Mode').selectOption('normal');
  await fill.getByRole('textbox', { name: 'Opacity' }).fill('50');
  await fill.getByRole('textbox', { name: 'Opacity' }).press('Enter');
  await expect(fill.getByLabel('Preserve Transparency')).toBeDisabled(); // the Background has no transparency
  await fill.getByRole('button', { name: 'OK' }).click();
  await expect(history(page).last()).toHaveText('Fill');
  const before = await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.active!.history.undo();
    return ws.active!.doc.background!.buffer.getPixel(5, 5);
  });
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  const after = await pixel(page, 5, 5);
  expect(after).toEqual([Math.round(before[0]! / 2), Math.round(before[1]! / 2), Math.round((before[2]! + 255) / 2)]);
});

test('Alt+Backspace fills the selection with the foreground colour; Ctrl/Cmd+Backspace with the background', async ({
  page,
}) => {
  await page.keyboard.press('ControlOrMeta+J'); // a layer
  await page.evaluate(async () => {
    const c = (window as unknown as AppWindow).__pixelforge;
    c.colors.setForeground({ r: 1, g: 0, b: 0 });
    c.colors.setBackground({ r: 0, g: 1, b: 0 });
    await c.workspace.execute({
      name: 'selectShape',
      params: { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 0, y: 0, w: 40, h: 64 } },
    });
  });
  await page.keyboard.press('Alt+Backspace');
  expect(await pixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 60, 10)).not.toEqual([255, 0, 0, 255]);
  await page.keyboard.press('ControlOrMeta+Backspace');
  expect(await pixel(page, 10, 10)).toEqual([0, 255, 0, 255]);
  await expect(history(page)).toHaveText(['Open', 'Duplicate Layer', 'Rectangular Marquee', 'Fill', 'Fill']);
});
