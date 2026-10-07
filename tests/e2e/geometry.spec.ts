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
    const ctx = (window as unknown as AppWindow).__pixelforge.canvas!.context;
    ctx.viewport.zoomTo(4);
    ctx.viewport.centerX = 48;
    ctx.viewport.centerY = 32;
    ctx.viewChanged();
  });
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

const history = (page: Page) => page.getByRole('listbox', { name: 'History states' }).getByRole('option');

/** Document size and resolution once commands have finished. */
const docSize = (page: Page) =>
  page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    const doc = ws.active!.doc;
    return { w: doc.width, h: doc.height, ppi: doc.resolution };
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

async function drag(page: Page, from: [number, number], to: [number, number]) {
  const a = await at(page, ...from);
  const b = await at(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

async function imageMenu(page: Page, ...path: string[]) {
  await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Image' }).click();
  for (const name of path.slice(0, -1)) await page.getByRole('menuitem', { name }).hover();
  await page.getByRole('menuitem', { name: path.at(-1) }).click();
}

test('Image Size: constrained width and height, resampling, and resolution only', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+Alt+I');
  const dialog = page.getByRole('dialog', { name: 'Image Size' });
  await expect(dialog).toContainText('Dimensions: 96 px × 64 px');
  const width = dialog.getByRole('textbox', { name: 'Width' });
  await expect(width).toBeFocused();
  await width.fill('48');
  await width.press('Tab');
  await expect(dialog.getByRole('textbox', { name: 'Height' })).toHaveValue('32');
  await expect(dialog).toContainText('Dimensions: 48 px × 32 px');
  await dialog.getByRole('combobox', { name: 'Resampling method' }).selectOption('bilinear');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(history(page).last()).toHaveText('Image Size');
  expect(await docSize(page)).toEqual({ w: 48, h: 32, ppi: 72 });

  // Without resampling, a new print size only changes the resolution.
  await page.keyboard.press('ControlOrMeta+Alt+I');
  await dialog.getByRole('checkbox', { name: 'Resample' }).uncheck();
  await expect(width).toBeDisabled(); // pixels cannot change
  await dialog.getByRole('combobox', { name: 'Width unit' }).selectOption('inches');
  await width.fill('0.32');
  await width.press('Enter'); // Enter applies the field and presses OK
  await expect(dialog).toBeHidden();
  expect(await docSize(page)).toEqual({ w: 48, h: 32, ppi: 150 });
  await page.keyboard.press('ControlOrMeta+Z');
  await page.keyboard.press('ControlOrMeta+Z');
  expect(await docSize(page)).toEqual({ w: 96, h: 64, ppi: 72 });
});

test('Canvas Size: relative growth from an anchor, in the extension colour; asks before cutting', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+Alt+C');
  const dialog = page.getByRole('dialog', { name: 'Canvas Size' });
  await dialog.getByRole('checkbox', { name: 'Relative' }).check();
  await expect(dialog.getByRole('textbox', { name: 'Width' })).toHaveValue('0');
  await dialog.getByRole('textbox', { name: 'Width' }).fill('20');
  await dialog.getByRole('textbox', { name: 'Height' }).fill('10');
  await dialog.getByRole('textbox', { name: 'Height' }).press('Tab');
  await dialog.getByRole('button', { name: 'Anchor top left' }).click();
  await expect(dialog.getByRole('button', { name: 'Anchor top left' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('combobox', { name: 'Canvas extension color' }).selectOption('black');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(history(page).last()).toHaveText('Canvas Size');
  expect(await docSize(page)).toMatchObject({ w: 116, h: 74 });
  const corner = await page.evaluate(() => {
    const doc = (window as unknown as AppWindow).__pixelforge.workspace.active!.doc;
    return doc.background!.buffer.getPixel(115, 73);
  });
  expect(corner).toEqual([0, 0, 0]);

  // Smaller: a warning first; cancelling it changes nothing. (From the menu this time.)
  await imageMenu(page, 'Canvas Size…');
  await expect(dialog.getByRole('textbox', { name: 'Width' })).toBeFocused();
  await dialog.getByRole('textbox', { name: 'Width' }).fill('50');
  await dialog.getByRole('button', { name: 'OK' }).click();
  const warning = page.getByRole('dialog', { name: 'Canvas Size' });
  await expect(warning).toContainText('part of the image will be cut off');
  await warning.getByRole('button', { name: 'Cancel' }).click();
  expect(await docSize(page)).toMatchObject({ w: 116, h: 74 });
});

test('Image Rotation and Flip from the Image menu; Image > Crop crops to the selection', async ({ page }) => {
  await imageMenu(page, 'Image Rotation', '90° Clockwise');
  await expect(history(page).last()).toHaveText('Rotate Canvas');
  expect(await docSize(page)).toMatchObject({ w: 64, h: 96 });
  await imageMenu(page, 'Image Rotation', 'Flip Canvas Horizontal');
  await expect(history(page).last()).toHaveText('Flip Canvas Horizontal');

  await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Image' }).click();
  await expect(page.getByRole('menuitem', { name: 'Crop', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('m');
  await drag(page, [10, 20], [40, 60]);
  await imageMenu(page, 'Crop');
  await expect(history(page).last()).toHaveText('Crop');
  expect(await docSize(page)).toMatchObject({ w: 30, h: 40 });
});

test('Crop tool: draw a box, resize it, Enter crops; Escape resets the box', async ({ page }) => {
  await page.keyboard.press('c');
  await expect(page.locator('.toolbar [data-tool="crop"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('checkbox', { name: 'Delete Cropped Pixels' })).toBeChecked();
  const box = () => page.evaluate(() => (window as unknown as AppWindow).__pixelforge.tools.crop.box);
  await drag(page, [10, 10], [50, 40]);
  expect(await box()).toEqual({ x: 10, y: 10, w: 40, h: 30 });
  await drag(page, [50, 40], [60, 44]); // the bottom-right handle
  expect(await box()).toEqual({ x: 10, y: 10, w: 50, h: 34 });
  await page.keyboard.press('Escape');
  expect(await box()).toBeNull();
  expect(await docSize(page)).toMatchObject({ w: 96, h: 64 });

  await drag(page, [10, 10], [50, 40]);
  await page.keyboard.press('Enter');
  await expect(history(page).last()).toHaveText('Crop');
  expect(await docSize(page)).toMatchObject({ w: 40, h: 30 });

  // A ratio preset reshapes the box; the options-bar button commits.
  await page.getByRole('combobox', { name: 'Crop ratio preset' }).selectOption('1:1');
  expect(await box()).toEqual({ x: 5, y: 0, w: 30, h: 30 });
  await page.getByRole('button', { name: 'Commit crop' }).click();
  expect(await docSize(page)).toMatchObject({ w: 30, h: 30 });
  await page.keyboard.press('v'); // another tool hides the box
  expect(await box()).toBeNull();
});
