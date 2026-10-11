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
    for (const t of [c.tools.blur, c.tools.sharpen, c.tools.smudge]) t.setOptions({ size: 12 });
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

const spread = (px: number[][]) => {
  // Average difference between neighbouring pixels (how sharp or noisy a row is).
  let s = 0;
  for (let i = 1; i < px.length; i++) s += Math.abs(px[i]![0]! - px[i - 1]![0]!);
  return s / (px.length - 1);
};

async function pick(page: Page, name: string) {
  await page
    .getByRole('button', { name: /^(Blur|Sharpen|Smudge) Tool/ })
    .first()
    .click({ button: 'right' });
  await page.getByRole('menu', { name: 'Tool group' }).getByRole('menuitemradio', { name }).click();
  await expect(toolTitle(page)).toHaveAttribute('title', new RegExp(name));
  await canvas(page).focus();
}

test('Blur softens and Sharpen (or Alt with Blur) sharpens; Smudge drags colour; each one History step', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Blur Tool' }).click();
  await expect(toolTitle(page)).toHaveAttribute('title', /Blur Tool/);
  await expect(page.getByRole('textbox', { name: 'Strength:' })).toHaveValue('50%');
  await expect(page.getByRole('combobox', { name: 'Mode', exact: true })).toHaveValue('normal');
  await page.getByRole('textbox', { name: 'Strength:' }).fill('100');
  await page.getByRole('textbox', { name: 'Strength:' }).press('Enter');
  await canvas(page).focus();
  const before = await region(page, 0, 16, 96, 1);
  await drag(page, [4, 16], [92, 16]);
  await expect(history(page).last()).toHaveText('Blur Tool');
  expect(spread(await region(page, 0, 16, 96, 1))).toBeLessThan(spread(before));

  const other = await region(page, 0, 40, 96, 1);
  await drag(page, [4, 40], [92, 40], true);
  await expect(history(page).last()).toHaveText('Sharpen Tool');
  expect(spread(await region(page, 0, 40, 96, 1))).toBeGreaterThan(spread(other));

  await pick(page, 'Sharpen Tool');
  await expect(page.getByRole('checkbox', { name: 'Protect Detail' })).toBeChecked();
  await pick(page, 'Smudge Tool');
  await expect(page.getByRole('checkbox', { name: 'Finger Painting' })).not.toBeChecked();
  await page.keyboard.press('8'); // Strength 80 %
  await expect(page.getByRole('textbox', { name: 'Strength:' })).toHaveValue('80%');
  const row = await region(page, 0, 56, 96, 1);
  await drag(page, [6, 56], [90, 56]);
  await expect(history(page).last()).toHaveText('Smudge Tool');
  const smudged = await region(page, 0, 56, 96, 1);
  expect(smudged.filter((p, i) => p.join() !== row[i]!.join()).length).toBeGreaterThan(40);
  await page.keyboard.press('ControlOrMeta+Z');
  expect(await region(page, 0, 56, 96, 1)).toEqual(row);
});
