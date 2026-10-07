import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { AppController } from '../../src/app/controller';

type AppWindow = { __pixelforge: AppController };

const FIXTURES = join(import.meta.dirname, '../fixtures/images');

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  (page as Page & { errors?: string[] }).errors = errors;
  await page.addInitScript(() => {
    Object.assign(window, { showOpenFilePicker: undefined, showSaveFilePicker: undefined });
  });
  await page.goto('/');
  await page.getByTestId('app-root').waitFor();
});

test.afterEach(({ page }) => {
  expect((page as Page & { errors?: string[] }).errors).toEqual([]);
});

const fg = (page: Page) => page.getByRole('button', { name: 'Set foreground color' });
const bg = (page: Page) => page.getByRole('button', { name: 'Set background color' });

test('swatches: black and white by default; X swaps, D restores', async ({ page }) => {
  await expect(fg(page)).toHaveAttribute('data-color', '#000000');
  await expect(bg(page)).toHaveAttribute('data-color', '#FFFFFF');
  await page.keyboard.press('x');
  await expect(fg(page)).toHaveAttribute('data-color', '#FFFFFF');
  await expect(bg(page)).toHaveAttribute('data-color', '#000000');
  await page.keyboard.press('d');
  await expect(fg(page)).toHaveAttribute('data-color', '#000000');
  await page.getByRole('button', { name: 'Switch foreground and background colors' }).click();
  await expect(fg(page)).toHaveAttribute('data-color', '#FFFFFF');
  await page.getByRole('button', { name: 'Default foreground and background colors' }).click();
  await expect(fg(page)).toHaveAttribute('data-color', '#000000');
});

test('Color Picker: hex, hue and the colour field set the colour; Cancel keeps the old one', async ({ page }) => {
  await fg(page).click();
  const dialog = page.getByRole('dialog', { name: 'Color Picker (Foreground Color)' });
  const hex = dialog.getByRole('textbox', { name: 'Hexadecimal colour' });
  await hex.fill('00ff00');
  await hex.press('Enter');
  await expect(dialog.getByRole('textbox', { name: 'Hue', exact: true })).toHaveValue('120°');
  await expect(dialog.getByRole('textbox', { name: 'Green', exact: true })).toHaveValue('255');
  // Typed math in the Hue field: 120° − 120 = red.
  const hue = dialog.getByRole('textbox', { name: 'Hue', exact: true });
  await hue.fill('120-120');
  await hue.press('Enter');
  await expect(hex).toHaveValue('FF0000');
  // The bottom-left of the field is black whatever the hue.
  const field = dialog.getByRole('slider', { name: 'Saturation and brightness' });
  const box = (await field.boundingBox())!;
  await page.mouse.click(box.x + 1, box.y + box.height - 1);
  await expect(dialog.getByRole('textbox', { name: 'Brightness', exact: true })).toHaveValue(/^[01]%$/);
  await page.keyboard.press('Shift+ArrowUp'); // brightness +10 %
  await page.keyboard.press('Shift+ArrowRight'); // saturation +10 %
  await expect(dialog.getByRole('textbox', { name: 'Brightness', exact: true })).toHaveValue(/^1[01]%$/);
  await hex.fill('3366CC');
  await hex.press('Enter');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(fg(page)).toHaveAttribute('data-color', '#3366CC');

  await bg(page).click();
  const second = page.getByRole('dialog', { name: 'Color Picker (Background Color)' });
  await second.getByRole('textbox', { name: 'Hexadecimal colour' }).fill('123456');
  await second.getByRole('button', { name: 'Cancel' }).click();
  await expect(bg(page)).toHaveAttribute('data-color', '#FFFFFF');
});

test('Delete on the Background opens Fill with the background colour', async ({ page }) => {
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+O');
  await (await chooser).setFiles(join(FIXTURES, 'photo.jpg'));
  await expect(page.getByRole('tab', { name: /photo\.jpg/ })).toBeVisible();
  await bg(page).click();
  const dialog = page.getByRole('dialog', { name: 'Color Picker (Background Color)' });
  await dialog.getByRole('textbox', { name: 'Hexadecimal colour' }).fill('FF0000');
  await dialog.getByRole('textbox', { name: 'Hexadecimal colour' }).press('Enter');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  const fill = page.getByRole('dialog', { name: 'Fill' });
  await expect(fill.getByLabel('Contents')).toHaveValue('background');
  await fill.getByRole('button', { name: 'OK' }).click();
  const pixel = await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    return ws.active!.doc.background!.buffer.getPixel(10, 10);
  });
  expect(pixel).toEqual([255, 0, 0]);
});
