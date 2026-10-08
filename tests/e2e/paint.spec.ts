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

/** Sets the brush size in the brush preset picker (the options bar shows it on the picker button). */
async function setSize(page: Page, px: number) {
  await page.getByRole('button', { name: 'Brush preset picker' }).click();
  const size = page.getByRole('group', { name: 'Brush settings' }).getByRole('textbox', { name: 'Size' });
  await size.fill(String(px));
  await size.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Brush settings' })).toBeHidden();
}

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

async function stroke(page: Page, points: [number, number][], hold: string[] = []) {
  const first = await at(page, ...points[0]!);
  for (const key of hold) await page.keyboard.down(key);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const p of points.slice(1)) {
    const s = await at(page, ...p);
    await page.mouse.move(s.x, s.y, { steps: 8 });
  }
  await page.mouse.up();
  for (const key of hold) await page.keyboard.up(key);
}

/** Pixel of the active layer once painting has finished. */
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

async function setForeground(page: Page, hex: string) {
  await page.getByRole('button', { name: 'Set foreground color' }).click();
  const dialog = page.getByRole('dialog', { name: /Color Picker/ });
  await dialog.getByRole('textbox', { name: 'Hexadecimal colour' }).fill(hex);
  await dialog.getByRole('textbox', { name: 'Hexadecimal colour' }).press('Enter');
  await dialog.getByRole('button', { name: 'OK' }).click();
}

test('brush paints the foreground colour as one undoable step', async ({ page }) => {
  await setForeground(page, 'FF0000');
  await page.keyboard.press('b');
  await expect(page.locator('.toolbar [data-tool="brush"]')).toHaveAttribute('aria-pressed', 'true');
  await setSize(page, 6);
  const before = await pixel(page, 30, 20);
  await page.getByLabel('Document canvas').focus();
  await stroke(page, [
    [10, 20],
    [60, 20],
  ]);
  await expect(history(page).last()).toHaveText('Brush Tool');
  expect(await pixel(page, 30, 20)).toEqual([255, 0, 0]);
  expect(await pixel(page, 30, 40)).not.toEqual([255, 0, 0]);
  await page.keyboard.press('ControlOrMeta+Z');
  expect(await pixel(page, 30, 20)).toEqual(before);
});

test('opacity caps a stroke that crosses itself; number keys set opacity', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+Alt+Shift+N'); // a transparent layer
  await page.keyboard.press('b');
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('5'); // 50 %
  await expect(page.getByRole('textbox', { name: 'Opacity:' })).toHaveValue('50%');
  await stroke(page, [
    [10, 30],
    [80, 30],
    [10, 30],
    [80, 30],
  ]);
  const p = await pixel(page, 40, 30);
  expect(p.slice(0, 3)).toEqual([0, 0, 0]);
  expect(p[3]).toBe(128); // 50 %, not more, however often the stroke crossed
  // Two quick digits: 2 then 5 → 25 % (sent back to back: the pairing is time-based). First
  // let the pairing window of the earlier "5" pass, or "5", "2" would pair as 52 %.
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    for (const key of ['2', '5'])
      window.dispatchEvent(new KeyboardEvent('keydown', { key, code: `Digit${key}`, bubbles: true }));
  });
  await expect(page.getByRole('textbox', { name: 'Opacity:' })).toHaveValue('25%');
});

test('[ ] change the size, Shift-click draws a straight line, selection limits painting', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+Alt+Shift+N');
  await page.keyboard.press('b');
  await page.getByLabel('Document canvas').focus();
  const picker = page.getByRole('button', { name: 'Brush preset picker' });
  await expect(picker).toHaveText('30');
  await page.keyboard.press(']');
  await expect(picker).toHaveText('35');
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  await expect(picker).toHaveText('25');
  await setSize(page, 4);
  await page.getByLabel('Document canvas').focus();

  // Click, then Shift-click: a straight line between them.
  const a = await at(page, 10, 10);
  await page.mouse.click(a.x, a.y);
  const b = await at(page, 70, 10);
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Shift');
  expect((await pixel(page, 40, 10))[3]).toBe(255);

  // With a selection, painting stays inside it.
  await page.keyboard.press('m');
  await page.getByLabel('Document canvas').focus();
  const s0 = await at(page, 0, 40);
  const s1 = await at(page, 48, 64);
  await page.mouse.move(s0.x, s0.y);
  await page.mouse.down();
  await page.mouse.move(s1.x, s1.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press('b');
  await stroke(page, [
    [20, 50],
    [80, 50],
  ]);
  expect((await pixel(page, 30, 50))[3]).toBe(255);
  expect((await pixel(page, 60, 50))[3]).toBe(0);
});

test('eraser erases to transparency on layers and to the background colour on the Background', async ({ page }) => {
  await page.keyboard.press('e');
  await expect(page.locator('.toolbar [data-tool="eraser"]')).toHaveAttribute('aria-pressed', 'true');
  await setSize(page, 6);
  await page.getByLabel('Document canvas').focus();
  await stroke(page, [
    [10, 20],
    [60, 20],
  ]);
  await expect(history(page).last()).toHaveText('Eraser');
  expect(await pixel(page, 30, 20)).toEqual([255, 255, 255]); // Background: white background colour
  await page.keyboard.press('ControlOrMeta+J'); // a layer copy
  await page.getByLabel('Document canvas').focus();
  await stroke(page, [
    [10, 40],
    [60, 40],
  ]);
  expect((await pixel(page, 30, 40))[3]).toBe(0);
});
