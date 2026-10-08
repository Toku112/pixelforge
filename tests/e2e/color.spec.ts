import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { AppController } from '../../src/app/controller';

type AppWindow = { __pixelforge: AppController };
type RGB = { r: number; g: number; b: number };

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
    ctx.viewport.zoomTo(4 * c.canvas!.renderer.devicePixelRatio);
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

/** The photo's pixel (0–1) at a point, or the average of a square around it. */
const photo = (page: Page, x: number, y: number, size = 1) =>
  page.evaluate(
    ([px, py, n]) => {
      const doc = (window as unknown as AppWindow).__pixelforge.workspace.active!.doc;
      const bg = doc.background as unknown as { buffer: { getPixel(x: number, y: number): number[] } };
      const sum = [0, 0, 0];
      const half = Math.floor(n! / 2);
      for (let y = py! - half; y < py! - half + n!; y++)
        for (let x = px! - half; x < px! - half + n!; x++) {
          const v = bg.buffer.getPixel(x, y);
          for (let c = 0; c < 3; c++) sum[c]! += v[c]!;
        }
      const k = n! * n! * 255;
      return { r: sum[0]! / k, g: sum[1]! / k, b: sum[2]! / k };
    },
    [x, y, size],
  );

const colors = (page: Page) =>
  page.evaluate(() => {
    const c = (window as unknown as AppWindow).__pixelforge.colors;
    return { fg: c.foreground, bg: c.background };
  });

const expectColor = (actual: RGB, expected: RGB) => {
  expect(actual.r).toBeCloseTo(expected.r, 3);
  expect(actual.g).toBeCloseTo(expected.g, 3);
  expect(actual.b).toBeCloseTo(expected.b, 3);
};

test('Eyedropper: picks the foreground (Alt: background), averages, and shows the sampling ring', async ({ page }) => {
  await page.keyboard.press('i');
  await expect(page.getByRole('combobox', { name: 'Sample size' })).toHaveValue('1');
  const p = await at(page, 30.5, 20.5);
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await colors(page)).fg.r).toBeCloseTo((await photo(page, 30, 20)).r, 3);
  expectColor((await colors(page)).fg, await photo(page, 30, 20));

  // Alt: the background colour.
  const q = await at(page, 60.5, 40.5);
  await page.keyboard.down('Alt');
  await page.mouse.click(q.x, q.y);
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await colors(page)).bg.r).toBeCloseTo((await photo(page, 60, 40)).r, 3);

  // 5 by 5 average.
  await page.getByRole('combobox', { name: 'Sample size' }).selectOption('5');
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await colors(page)).fg.g).toBeCloseTo((await photo(page, 30, 20, 5)).g, 3);

  // While dragging, the ring shows round the pointer; it goes when released.
  const ringAlpha = () =>
    page.evaluate(
      ([x, y]) => {
        const c = (window as unknown as AppWindow).__pixelforge.canvas!;
        const v = c.context.viewport.docToView({ x: x!, y: y! });
        const dpr = c.renderer.devicePixelRatio;
        (c.selectionOverlay as unknown as { draw(): void }).draw();
        const el = document.querySelector<HTMLCanvasElement>('canvas.selection-overlay')!;
        return el.getContext('2d')!.getImageData(Math.round(v.x), Math.round(v.y - 46 * dpr), 1, 1).data[3]!;
      },
      [40, 30],
    );
  const r = await at(page, 40, 30);
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.move(r.x + 1, r.y);
  await page.mouse.move(r.x, r.y);
  await expect.poll(ringAlpha).toBe(255);
  await page.mouse.up();
  await expect.poll(ringAlpha).toBe(0);
});

test('Sample: the current layer only, or all layers; Alt-click with the Brush picks without painting', async ({
  page,
}) => {
  await page.keyboard.press('ControlOrMeta+Alt+Shift+N'); // an empty layer, now current
  await page.getByLabel('Document canvas').focus();
  await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.colors.setForeground({ r: 0, g: 1, b: 0 }));
  await page.keyboard.press('i');
  await page.getByRole('combobox', { name: 'Sample', exact: true }).selectOption('current');
  const p = await at(page, 30.5, 20.5);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(200);
  expect((await colors(page)).fg).toEqual({ r: 0, g: 1, b: 0 }); // nothing painted on the empty layer
  await page.getByRole('combobox', { name: 'Sample', exact: true }).selectOption('all');
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await colors(page)).fg.g).toBeCloseTo((await photo(page, 30, 20)).g, 3);

  // With the Brush, Alt-click picks the colour (and paints nothing).
  await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.colors.setForeground({ r: 0, g: 0, b: 1 }));
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('b');
  const entries = await page.getByRole('listbox', { name: 'History states' }).getByRole('option').count();
  const q = await at(page, 70.5, 10.5);
  await page.keyboard.down('Alt');
  await page.mouse.click(q.x, q.y);
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await colors(page)).fg.r).toBeCloseTo((await photo(page, 70, 10)).r, 3);
  await expect(page.getByRole('listbox', { name: 'History states' }).getByRole('option')).toHaveCount(entries);
});

test('Color panel: sliders, hex value and ramp set the foreground or the background', async ({ page }) => {
  await page.keyboard.press('F6');
  const panel = page.locator('.color-panel');
  await expect(panel).toBeVisible();
  await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.colors.setForeground({ r: 0, g: 0, b: 0 }));
  const red = panel.getByRole('textbox', { name: 'R value' });
  await red.fill('200');
  await red.press('Enter');
  expect((await colors(page)).fg.r).toBeCloseTo(200 / 255, 5);

  await panel.getByRole('combobox', { name: 'Color sliders' }).selectOption('hsb');
  const hue = panel.getByRole('textbox', { name: 'H value' });
  await expect(hue).toHaveValue('0°');
  const hex = panel.getByRole('textbox', { name: 'Hex color' });
  await hex.fill('00ff00');
  await hex.press('Enter');
  expect((await colors(page)).fg).toEqual({ r: 0, g: 1, b: 0 });
  await expect(hue).toHaveValue('120°');

  // The background, from the ramp's white top edge.
  await panel.getByRole('radio', { name: 'Background color' }).click();
  const ramp = (await panel.getByRole('img', { name: 'Color ramp' }).boundingBox())!;
  await page.mouse.click(ramp.x + ramp.width / 2, ramp.y + 1);
  const bg = (await colors(page)).bg;
  expect(bg.r + bg.g + bg.b).toBeGreaterThan(2.7); // near white
  expect((await colors(page)).fg).toEqual({ r: 0, g: 1, b: 0 });
});

test('Swatches: choose, add, delete, import a swatch file, and keep them', async ({ page }) => {
  await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Swatches' }).click();
  const panel = page.locator('.swatches-panel');
  await panel.getByRole('option', { name: 'Red', exact: true }).click();
  expect((await colors(page)).fg).toEqual({ r: 1, g: 0, b: 0 });
  await panel.getByRole('option', { name: 'Blue', exact: true }).click({ modifiers: ['ControlOrMeta'] });
  expect((await colors(page)).bg).toEqual({ r: 0, g: 0, b: 1 });

  await page.evaluate(() =>
    (window as unknown as AppWindow).__pixelforge.colors.setForeground({ r: 0.2, g: 0.4, b: 0.6 }),
  );
  await panel.getByRole('button', { name: 'New swatch', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Color Swatch Name' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Steel');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(panel.getByRole('option', { name: 'Steel' })).toBeVisible();

  await panel.getByRole('option', { name: 'Steel' }).click();
  await panel.getByRole('button', { name: 'Delete swatch' }).click();
  await expect(panel.getByRole('option', { name: 'Steel' })).toHaveCount(0);

  // An .ase file with one group of two colours.
  const utf16 = (s: string) => [0, s.length + 1, ...[...s].flatMap((c) => [0, c.charCodeAt(0)]), 0, 0];
  const f32 = (v: number) => {
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, v);
    return [0, 1, 2, 3].map((i) => b.getUint8(i));
  };
  const block = (type: number, body: number[]) => [
    type >> 8,
    type & 255,
    0,
    0,
    body.length >> 8,
    body.length & 255,
    ...body,
  ];
  const color = (name: string, rgb: number[]) =>
    block(0x0001, [...utf16(name), ...[...'RGB '].map((c) => c.charCodeAt(0)), ...rgb.flatMap(f32), 0, 2]);
  const blocks = [
    block(0xc001, utf16('Sunset')),
    color('Glow', [1, 0.6, 0.2]),
    color('Dusk', [0.3, 0.1, 0.4]),
    block(0xc002, []),
  ];
  const ase = Buffer.from(
    [...'ASEF'].map((c) => c.charCodeAt(0)).concat([0, 1, 0, 0, 0, 0, 0, blocks.length], blocks.flat()),
  );
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.floating-panel').getByRole('button', { name: 'Panel menu' }).click();
  await page.getByRole('menuitem', { name: 'Import Swatches…' }).click();
  await (await chooser).setFiles({ name: 'sunset.ase', mimeType: 'application/octet-stream', buffer: ase });
  const sunset = panel.getByRole('group', { name: 'Sunset' });
  await expect(sunset.getByRole('option')).toHaveCount(2);
  await sunset.getByRole('option', { name: 'Glow' }).click();
  expectColor((await colors(page)).fg, { r: 1, g: 0.6, b: 0.2 });

  // Kept after a reload.
  await page.reload();
  await page.getByTestId('app-root').waitFor();
  const names = await page.evaluate(async () => {
    const lib = (window as unknown as AppWindow).__pixelforge.services.swatches;
    await lib.ready;
    return lib.groups().map((g) => g.name);
  });
  expect(names).toContain('Sunset');
});
