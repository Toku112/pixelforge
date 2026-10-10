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
    c.tools.mixerBrush.setOptions({ size: 12 });
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

async function drag(page: Page, from: [number, number], to: [number, number]) {
  const a = await at(page, from[0], from[1]);
  const b = await at(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 20 });
  await page.mouse.up();
}

async function altClick(page: Page, x: number, y: number) {
  const p = await at(page, x, y);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Alt');
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

const changed = (a: number[][], b: number[][]) => a.filter((p, i) => p.join() !== b[i]!.join()).length;
const history = (page: Page) => page.getByRole('listbox', { name: 'History states' }).getByRole('option');
const canvas = (page: Page) => page.getByLabel('Document canvas');
const toolTitle = (page: Page) => page.getByRole('button', { name: 'Tool preset picker' });

/** The last History step's recorded Mixer Brush settings and start. */
const recorded = (page: Page) =>
  page.evaluate(() => {
    const h = (window as unknown as AppWindow).__pixelforge.workspace.active!.history;
    return h.descriptorOf(h.entries.at(-1)!.id)?.params['mixer'] as {
      wet: number;
      reservoir: { width: number } | null;
      level: number;
    };
  });

async function mixerBrush(page: Page) {
  await page.keyboard.press('b');
  await page.keyboard.press('Shift+B');
  await page.keyboard.press('Shift+B');
  await expect(toolTitle(page)).toHaveAttribute('title', /Mixer Brush Tool/);
}

async function menu(page: Page, item: string) {
  await page.getByRole('button', { name: 'Brush load menu' }).click();
  await page
    .getByRole('menu', { name: 'Brush load' })
    .getByRole(/Only/.test(item) ? 'menuitemcheckbox' : 'menuitem', { name: item })
    .click();
  await canvas(page).focus();
}

test('Shift+B reaches the Mixer Brush; a clean wet brush drags the colours along, one History step', async ({
  page,
}) => {
  await mixerBrush(page);
  await expect(page.getByRole('textbox', { name: 'Wet:' })).toHaveValue('100%');
  await expect(page.getByRole('textbox', { name: 'Load:' })).toHaveValue('50%');
  await expect(page.getByRole('textbox', { name: 'Mix:' })).toHaveValue('50%');
  await expect(page.getByRole('button', { name: 'Load the brush after each stroke' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Load the brush after each stroke' }).click();
  await menu(page, 'Clean Brush');
  await expect(page.getByRole('button', { name: 'Current brush load' })).toHaveAttribute('title', /is clean/);
  const before = await region(page, 0, 26, 96, 12);
  await drag(page, [8, 32], [88, 32]);
  await expect(history(page).last()).toHaveText('Mixer Brush');
  const after = await region(page, 0, 26, 96, 12);
  expect(changed(before, after)).toBeGreaterThan(200);
  expect((await recorded(page)).reservoir).toBeNull();
  await page.keyboard.press('ControlOrMeta+Z');
  expect(await region(page, 0, 26, 96, 12)).toEqual(before);
});

test('Alt-click loads paint from the image; a dry brush paints it, a solid load its average', async ({ page }) => {
  await mixerBrush(page);
  await page.getByRole('combobox', { name: 'Useful mixer brush combinations' }).selectOption('dry-heavy-load');
  await expect(page.getByRole('textbox', { name: 'Wet:' })).toHaveValue('0%');
  await expect(page.getByRole('textbox', { name: 'Mix:' })).toBeDisabled();
  await canvas(page).focus();
  await altClick(page, 20, 20);
  await expect(page.getByRole('button', { name: 'Current brush load' })).toHaveAttribute(
    'title',
    /paint from the image/,
  );
  await expect(history(page)).toHaveCount(1); // loading is not a History step
  const before = await region(page, 0, 44, 96, 12);
  await drag(page, [10, 50], [86, 50]);
  await expect(history(page).last()).toHaveText('Mixer Brush');
  expect(changed(before, await region(page, 0, 44, 96, 12))).toBeGreaterThan(200);
  const image = await recorded(page);
  expect(image.wet).toBe(0);
  expect(image.reservoir!.width).toBe(12);

  await menu(page, 'Load Solid Colors Only');
  await altClick(page, 20, 20);
  await drag(page, [10, 10], [86, 10]);
  await expect(history(page)).toHaveCount(3);
  expect((await recorded(page)).reservoir!.width).toBe(1);
});

test('a recorded stroke replays exactly as it was painted (Actions)', async ({ page }) => {
  await mixerBrush(page);
  await page.getByRole('combobox', { name: 'Useful mixer brush combinations' }).selectOption('wet');
  await canvas(page).focus();
  await drag(page, [8, 20], [88, 44]);
  await expect(history(page).last()).toHaveText('Mixer Brush');
  const live = await region(page, 0, 0, 96, 64);
  await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    const h = ws.active!.history;
    const d = JSON.parse(JSON.stringify(h.descriptorOf(h.entries.at(-1)!.id))) as Parameters<typeof ws.execute>[0];
    await h.undo();
    await ws.execute(d);
  });
  expect(await region(page, 0, 0, 96, 64)).toEqual(live);
});

test('Sample All Layers paints what the layers below show onto an empty layer', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+Alt+Shift+N'); // a new, empty layer
  await expect(history(page).last()).toHaveText('New Layer');
  await mixerBrush(page);
  await menu(page, 'Clean Brush');
  await page.getByRole('button', { name: 'Load the brush after each stroke' }).click();
  await drag(page, [8, 32], [88, 32]);
  await expect(history(page).last()).toHaveText('Mixer Brush');
  const alone = await region(page, 0, 26, 96, 12);
  expect(alone.filter((p) => p[3]! > 0)).toHaveLength(0); // nothing to take up on an empty layer
  await page.getByRole('checkbox', { name: 'Sample All Layers' }).check();
  await canvas(page).focus();
  await drag(page, [8, 32], [88, 32]);
  await expect(history(page)).toHaveCount(4);
  const sampled = await region(page, 0, 26, 96, 12);
  expect(sampled.filter((p) => p[3]! > 0).length).toBeGreaterThan(200);
});
