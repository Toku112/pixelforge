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
    for (const t of [c.tools.dodge, c.tools.burn, c.tools.sponge]) t.setOptions({ size: 12 });
  });
  await canvas(page).focus();
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

async function at(page: Page, x: number, y: number) {
  const box = (await canvas(page).boundingBox())!;
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

async function drag(page: Page, from: [number, number], to: [number, number], alt = false) {
  const a = await at(page, from[0], from[1]);
  const b = await at(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.down();
  if (alt) await page.keyboard.up('Alt');
  await page.mouse.move(b.x, b.y, { steps: 20 });
  await page.mouse.up();
}

/** The active layer's pixels in a rectangle, once painting has finished. */
const region = (page: Page, x: number, y: number, w: number, h: number) =>
  page.evaluate(
    async ([rx, ry, rw, rh]) => {
      const ws = (window as unknown as AppWindow).__pixelforge.workspace;
      await ws.whenIdle();
      const l = ws.active!.doc.activeLayer as { buffer: { getPixel(x: number, y: number): number[] } };
      const out: number[][] = [];
      for (let y = ry!; y < ry! + rh!; y++) for (let x = rx!; x < rx! + rw!; x++) out.push(l.buffer.getPixel(x, y));
      return out;
    },
    [x, y, w, h],
  );

const history = (page: Page) => page.getByRole('listbox', { name: 'History states' }).getByRole('option');
const canvas = (page: Page) => page.getByLabel('Document canvas');
const toolTitle = (page: Page) => page.getByRole('button', { name: 'Tool preset picker' });
const sum = (px: number[][]) => px.reduce((s, p) => s + p[0]! + p[1]! + p[2]!, 0);

test('O picks Dodge: it lightens; Alt burns for one stroke; Shift+O reaches Burn and Sponge', async ({ page }) => {
  await page.keyboard.press('o');
  await expect(toolTitle(page)).toHaveAttribute('title', /Dodge Tool/);
  await expect(page.getByRole('combobox', { name: 'Range' })).toHaveValue('midtones');
  await expect(page.getByRole('textbox', { name: 'Exposure:' })).toHaveValue('50%');
  await expect(page.getByRole('checkbox', { name: 'Protect Tones' })).toBeChecked();
  const before = await region(page, 0, 28, 96, 8);
  await drag(page, [8, 32], [88, 32]);
  await expect(history(page).last()).toHaveText('Dodge Tool');
  const dodged = await region(page, 0, 28, 96, 8);
  expect(sum(dodged)).toBeGreaterThan(sum(before));

  const lower = await region(page, 0, 48, 96, 8);
  await drag(page, [8, 52], [88, 52], true);
  await expect(history(page).last()).toHaveText('Burn Tool');
  expect(sum(await region(page, 0, 48, 96, 8))).toBeLessThan(sum(lower));
  await expect(toolTitle(page)).toHaveAttribute('title', /Dodge Tool/); // still the Dodge tool

  // Number keys set the Exposure.
  await page.keyboard.press('3');
  await expect(page.getByRole('textbox', { name: 'Exposure:' })).toHaveValue('30%');

  await page.keyboard.press('Shift+O');
  await expect(toolTitle(page)).toHaveAttribute('title', /Burn Tool/);
  await page.keyboard.press('Shift+O');
  await expect(toolTitle(page)).toHaveAttribute('title', /Sponge Tool/);
  await expect(page.getByRole('combobox', { name: 'Sponge mode' })).toHaveValue('desaturate');
  await expect(page.getByRole('textbox', { name: 'Flow:' })).toHaveValue('50%');
  await expect(page.getByRole('checkbox', { name: 'Vibrance' })).toBeChecked();
  const colourful = await region(page, 0, 8, 96, 8);
  const spread = (px: number[][]) =>
    px.reduce((s, p) => s + Math.max(...p.slice(0, 3)) - Math.min(...p.slice(0, 3)), 0);
  await drag(page, [8, 12], [88, 12]);
  await expect(history(page).last()).toHaveText('Sponge Tool');
  expect(spread(await region(page, 0, 8, 96, 8))).toBeLessThan(spread(colourful));
  await page.keyboard.press('ControlOrMeta+Z');
  expect(await region(page, 0, 8, 96, 8)).toEqual(colourful);
});
