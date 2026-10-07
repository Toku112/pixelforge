import { readFile } from 'node:fs/promises';
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
  // Native file dialogs cannot be driven by tests: use the file-input and download fallbacks.
  await page.addInitScript(() => {
    Object.assign(window, { showOpenFilePicker: undefined, showSaveFilePicker: undefined });
  });
  await page.goto('/');
  await page.getByTestId('app-root').waitFor();
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

async function open(page: Page, file: string | { name: string; buffer: Buffer }) {
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+O');
  await (
    await chooser
  ).setFiles(
    typeof file === 'string'
      ? join(FIXTURES, file)
      : { name: file.name, mimeType: 'application/octet-stream', buffer: file.buffer },
  );
  const name = typeof file === 'string' ? file : file.name;
  await expect(page.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) })).toBeVisible();
}

/** Every pixel of the active document's single layer, plus size and resolution. */
const image = (page: Page) =>
  page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    const doc = ws.active!.doc;
    const layer = doc.root.children[0] as unknown as {
      buffer: { readRegion(r: { x: number; y: number; w: number; h: number }): ArrayLike<number> };
      isBackground: boolean;
    };
    return {
      w: doc.width,
      h: doc.height,
      ppi: doc.resolution,
      background: layer.isBackground,
      pixels: Array.from(layer.buffer.readRegion({ x: 0, y: 0, w: doc.width, h: doc.height })),
    };
  });

async function saveAs(page: Page, format: string) {
  await page.keyboard.press('ControlOrMeta+Shift+S');
  const dialog = page.getByRole('dialog', { name: 'Save As' });
  await dialog.getByLabel('Format').selectOption(format);
  await dialog.getByRole('button', { name: 'Save' }).click();
}

test('Save As JPEG asks for options, then writes a JPEG that reopens closely', async ({ page }) => {
  await open(page, 'photo.jpg');
  const before = await image(page);
  await page.keyboard.press('ControlOrMeta+Shift+S');
  const saveDialog = page.getByRole('dialog', { name: 'Save As' });
  await expect(saveDialog.getByLabel('Format')).toHaveValue('jpeg'); // a flat JPEG stays a JPEG
  await saveDialog.getByRole('button', { name: 'Save' }).click();
  const options = page.getByRole('dialog', { name: 'JPEG Options' });
  await expect(options.getByLabel('Matte')).toHaveCount(0); // opaque image: no matte needed
  await options.getByLabel('Quality preset').selectOption('maximum');
  await expect(options.getByRole('textbox', { name: 'Quality' })).toHaveValue('10');
  await options.getByRole('radio', { name: 'Progressive' }).check();
  await expect(options).toContainText(/Size: about \d/);
  const download = page.waitForEvent('download');
  await options.getByRole('button', { name: 'OK' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('photo.jpg');
  const bytes = await readFile(await file.path());
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  expect(bytes.includes(Buffer.from([0xff, 0xc2]))).toBe(true); // progressive frame

  await open(page, { name: 'photo-saved.jpg', buffer: bytes });
  const after = await image(page);
  expect([after.w, after.h, after.ppi, after.background]).toEqual([before.w, before.h, before.ppi, true]);
  let total = 0;
  for (let i = 0; i < before.pixels.length; i++) total += Math.abs(before.pixels[i]! - after.pixels[i]!);
  expect(total / before.pixels.length).toBeLessThan(3); // high quality: small average error
});

test('Save As WebP writes a lossless copy with transparency', async ({ page }) => {
  await open(page, 'rgba8.png');
  const before = await image(page);
  await saveAs(page, 'webp');
  const options = page.getByRole('dialog', { name: 'WebP Options' });
  await options.getByRole('radio', { name: 'Lossless (exact)' }).check();
  await expect(options.getByRole('textbox', { name: 'Quality' })).toBeDisabled();
  const download = page.waitForEvent('download');
  await options.getByRole('button', { name: 'OK' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('rgba8.webp');
  const bytes = await readFile(await file.path());
  expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
  await open(page, { name: 'rgba8-saved.webp', buffer: bytes });
  const after = await image(page);
  expect(after.background).toBe(false);
  // Lossless: identical where visible (fully transparent pixels may lose their colour).
  for (let i = 0; i < before.pixels.length; i += 4) {
    if (before.pixels[i + 3] === 0) expect(after.pixels[i + 3]).toBe(0);
    else expect(after.pixels.slice(i, i + 4)).toEqual(before.pixels.slice(i, i + 4));
  }
});

test('lossy WebP uses the browser encoder where there is one', async ({ page }) => {
  await open(page, 'photo.jpg');
  const before = await image(page);
  await saveAs(page, 'webp');
  const options = page.getByRole('dialog', { name: 'WebP Options' });
  const lossy = options.getByRole('radio', { name: 'Lossy (smaller files)' });
  if (await lossy.isDisabled()) {
    // Safari's engine cannot encode WebP: only lossless is offered, with the reason.
    await expect(options).toContainText('cannot make lossy WebP files');
    await expect(options.getByRole('radio', { name: 'Lossless (exact)' })).toBeChecked();
    await options.getByRole('button', { name: 'Cancel' }).click();
    return;
  }
  await expect(lossy).toBeChecked();
  await options.getByRole('textbox', { name: 'Quality' }).fill('90');
  await expect(options).toContainText(/Size: about \d/);
  const download = page.waitForEvent('download');
  await options.getByRole('button', { name: 'OK' }).click();
  const bytes = await readFile(await (await download).path());
  expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
  expect(bytes.subarray(12, 16).toString('latin1')).toMatch(/^VP8[ X]$/); // lossy (or extended) bitstream
  await open(page, { name: 'photo-saved.webp', buffer: bytes });
  const after = await image(page);
  expect([after.w, after.h]).toEqual([before.w, before.h]);
  // Lossy WebP always halves the colour resolution: compare brightness. On this synthetic image the
  // browsers' encoders differ from the original by about 4.8 on average (our decoder reads their
  // files exactly as the browsers themselves do).
  const luma = (p: number[], i: number) => 0.299 * p[i]! + 0.587 * p[i + 1]! + 0.114 * p[i + 2]!;
  let total = 0;
  for (let i = 0; i < before.pixels.length; i += 3) total += Math.abs(luma(before.pixels, i) - luma(after.pixels, i));
  expect(total / (before.pixels.length / 3)).toBeLessThan(6);
});

test('JPEG of a transparent image offers a matte; Cancel stops the save', async ({ page }) => {
  await open(page, 'rgba8.png');
  await saveAs(page, 'jpeg');
  const options = page.getByRole('dialog', { name: 'JPEG Options' });
  await expect(options.getByLabel('Matte')).toHaveValue('white');
  await options.getByRole('button', { name: 'Cancel' }).click();
  await expect(options).toBeHidden();
  await expect(page.getByRole('tab', { name: /rgba8\.png/ })).toBeVisible();
});
