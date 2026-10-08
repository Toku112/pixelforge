import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { AppController } from '../../src/app/controller';
import type { SolidGradient } from '../../src/core/paint/gradient';
import { readGrd } from '../../src/io/grd';

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
  await page.keyboard.press('ControlOrMeta+Alt+Shift+N'); // a new, empty layer
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('g');
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

async function drag(page: Page, from: [number, number], to: [number, number], shift = false) {
  const a = await at(page, from[0], from[1]);
  const b = await at(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

/** The active layer's pixel (RGBA). */
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

test('G draws a gradient over the layer as one History step; Shift keeps the drag to 45°', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Tool preset picker' })).toHaveAttribute('title', /Gradient Tool/);
  await page.getByRole('combobox', { name: 'Gradient method' }).selectOption('classic');
  await page.getByRole('checkbox', { name: 'Dither' }).uncheck();
  await page.getByLabel('Document canvas').focus();
  // A slanted drag with Shift: kept horizontal.
  await drag(page, [20.5, 30], [76.5, 37], true);
  await expect(history(page).last()).toHaveText('Gradient');
  expect(await pixel(page, 10, 3)).toEqual([0, 0, 0, 255]); // before the start: the foreground colour
  expect(await pixel(page, 90, 60)).toEqual([255, 255, 255, 255]); // after the end: the background colour
  const middle = await pixel(page, 48, 5);
  expect(middle[0]).toBeGreaterThanOrEqual(127);
  expect(middle[0]).toBeLessThanOrEqual(128);
  expect(await pixel(page, 48, 60)).toEqual(middle); // straight across: the same down the column

  // Reflected and Reverse: the drag start is white, both sides darken towards black.
  await page.getByRole('radio', { name: 'Reflected Gradient' }).click();
  await page.getByRole('checkbox', { name: 'Reverse' }).check();
  await page.getByLabel('Document canvas').focus();
  await drag(page, [48.5, 32], [78.5, 32]);
  expect(await pixel(page, 48, 10)).toEqual([255, 255, 255, 255]);
  expect((await pixel(page, 20, 10))[0]).toBeLessThan(20);
  expect((await pixel(page, 76, 10))[0]).toBeLessThan(20);

  // Number keys set the tool's opacity; undo takes the gradient away again.
  await page.keyboard.press('5');
  await expect(page.getByRole('textbox', { name: 'Opacity:' })).toHaveValue('50%');
  await page.keyboard.press('ControlOrMeta+Z');
  await page.keyboard.press('ControlOrMeta+Z');
  expect(await pixel(page, 10, 3)).toEqual([0, 0, 0, 0]);
});

test('the Gradient Editor adds, colours, moves and removes stops; Alt turns Cancel into Reset', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit the gradient' }).click();
  const editor = page.getByRole('dialog', { name: 'Gradient Editor' });
  const colorRow = editor.locator('.gradient-stop-row.color');
  const stops = editor.getByRole('button', { name: /^Color stop at/ });
  await expect(stops).toHaveCount(2);
  // A click below the bar adds a colour stop there.
  await colorRow.click({ position: { x: 90, y: 9 } });
  await expect(stops).toHaveCount(3);
  await editor.getByRole('textbox', { name: 'Location:' }).fill('50');
  await editor.getByRole('textbox', { name: 'Location:' }).press('Enter');
  await editor.getByRole('button', { name: 'Stop color', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Color Picker (Stop Color)' });
  await picker.getByRole('textbox', { name: 'Hexadecimal colour' }).fill('FF0000');
  await picker.getByRole('textbox', { name: 'Hexadecimal colour' }).press('Enter');
  await picker.getByRole('button', { name: 'OK' }).click();
  await expect(editor.getByRole('combobox', { name: 'Stop color type' })).toHaveValue('color');

  // Another stop, dragged away from the bar: removed again.
  await colorRow.click({ position: { x: 300, y: 9 } });
  await expect(stops).toHaveCount(4);
  const extra = editor.getByRole('button', { name: /^Color stop at 83/ });
  const box = (await extra.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 60, { steps: 4 });
  await page.mouse.up();
  await expect(stops).toHaveCount(3);
  await editor.getByRole('button', { name: 'OK' }).click();

  const gradient = await page.evaluate(
    () => (window as unknown as AppWindow).__pixelforge.tools.gradient.options.gradient as SolidGradient,
  );
  expect(gradient.colorStops.map((s) => [s.location, s.kind])).toEqual([
    [0, 'foreground'],
    [1, 'background'],
    [0.5, 'color'],
  ]);
  expect(gradient.colorStops[2]!.color).toEqual({ r: 1, g: 0, b: 0 });
  await page.getByRole('checkbox', { name: 'Dither' }).uncheck();
  await page.getByLabel('Document canvas').focus();
  await drag(page, [0.5, 32], [95.5, 32]);
  const red = await pixel(page, 47, 20);
  expect(red[0]).toBeGreaterThan(240);
  expect(red[1]).toBeLessThan(30);

  // Reset brings back the gradient the editor opened with.
  await page.getByRole('button', { name: 'Edit the gradient' }).click();
  await editor.locator('.gradient-stop-row.color').click({ position: { x: 300, y: 9 } });
  await expect(stops).toHaveCount(4);
  await page.keyboard.down('Alt');
  await editor.getByRole('button', { name: 'Reset' }).click();
  await page.keyboard.up('Alt');
  await expect(stops).toHaveCount(3);
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toHaveCount(0);
});

test('the Gradients panel chooses, adds, exports and imports gradients (.grd)', async ({ page }) => {
  await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.services.gradients.ready);
  await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Gradients' }).click();
  const panel = page.locator('.floating-panel');
  await panel.getByRole('option', { name: 'Spectrum' }).click();
  await expect(panel.getByRole('option', { name: 'Spectrum' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Edit the gradient' })).toHaveAttribute('title', /Spectrum/);

  // New Gradient: the tool's gradient as a preset in the selected preset's group.
  await panel.getByRole('button', { name: 'New gradient', exact: true }).click();
  const name = page.getByRole('dialog', { name: 'Gradient Name' });
  await name.getByRole('textbox').fill('Rainbow Copy');
  await name.getByRole('button', { name: 'OK' }).click();
  const colors = panel.getByRole('group', { name: 'Colors', exact: true });
  await expect(colors.getByRole('option', { name: 'Rainbow Copy' })).toBeVisible();

  // Export the group…
  await panel.getByRole('button', { name: 'Panel menu' }).click();
  await page.getByRole('menuitem', { name: 'Export Selected Gradients…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export Gradients' });
  await expect(dialog.getByRole('checkbox', { name: 'Colors' })).toBeChecked();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Colors.grd');
  const bytes = await readFile(await file.path());
  expect(readGrd(new Uint8Array(bytes)).gradients.map((g) => g.name)).toContain('Rainbow Copy');

  // …and import it back: a group named after the file (numbered, as "Colors" exists).
  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Panel menu' }).click();
  await page.getByRole('menuitem', { name: 'Import Gradients…' }).click();
  await (await chooser).setFiles({ name: 'Colors.grd', mimeType: 'application/octet-stream', buffer: bytes });
  const imported = panel.getByRole('group', { name: 'Colors 2' });
  await expect(imported.getByRole('option')).toHaveCount(6);

  // Kept after a reload.
  await page.waitForTimeout(200);
  await page.reload();
  await page.getByTestId('app-root').waitFor();
  await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.services.gradients.ready);
  const groups = await page.evaluate(() =>
    (window as unknown as AppWindow).__pixelforge.services.gradients.groups().map((g) => g.name),
  );
  expect(groups).toContain('Colors 2');
});

test('a locked layer cannot take a gradient: the user is told why', async ({ page }) => {
  await page.evaluate(() => {
    const doc = (window as unknown as AppWindow).__pixelforge.workspace.active!.doc;
    const layer = doc.activeLayer!;
    layer.locks = { ...layer.locks, all: true };
  });
  await drag(page, [10, 10], [80, 10]);
  const alert = page.getByRole('dialog', { name: 'Gradient Tool' });
  await expect(alert).toContainText('locked');
  await alert.getByRole('button', { name: 'OK' }).click();
  await expect(history(page).last()).not.toHaveText('Gradient');
});
