import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { AppController } from '../../src/app/controller';

type AppWindow = { __pixelforge: AppController };
type BrushOptions = { size: number; hardness: number; opacity: number; angle: number; roundness: number };

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
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('b');
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

const canvas = (page: Page) => page.getByLabel('Document canvas');

/** Canvas-page position of a document point. */
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

const brush = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as AppWindow).__pixelforge.tools.byId.get('brush') as unknown as {
        options: BrushOptions & {
          spacingEnabled: boolean;
          dynamics: { buildUp: boolean; shape: { enabled: boolean } };
        };
      },
  );

const setBrush = (page: Page, options: Partial<BrushOptions>) =>
  page.evaluate((o) => {
    const c = (window as unknown as AppWindow).__pixelforge;
    (c.tools.byId.get('brush') as unknown as { setOptions(o: object): void }).setOptions(o);
  }, options);

/** Alpha of the overlay canvas (cursor, HUD) at a document point, and its colour. */
const overlayAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([dx, dy]) => {
      const c = (window as unknown as AppWindow).__pixelforge.canvas!;
      const v = c.context.viewport.docToView({ x: dx!, y: dy! });
      const ants = c.selectionOverlay as unknown as { draw(): void };
      ants.draw();
      const el = document.querySelector<HTMLCanvasElement>('canvas.selection-overlay')!;
      const d = el.getContext('2d')!.getImageData(Math.round(v.x), Math.round(v.y), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!, d[3]!];
    },
    [x, y],
  );

/** The most opaque overlay pixel along a short horizontal run around a document point (outlines are thin). */
async function outlineNear(page: Page, x: number, y: number): Promise<number> {
  let best = 0;
  for (const dx of [-0.5, -0.25, 0, 0.25, 0.5]) best = Math.max(best, (await overlayAt(page, x + dx, y))[3]!);
  return best;
}

async function openPreferences(page: Page) {
  await canvas(page).focus();
  await page.keyboard.press('ControlOrMeta+K');
  const dialog = page.getByRole('dialog', { name: 'Preferences' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('the options bar toggles Brush Settings and the airbrush, and sets the brush angle', async ({ page }) => {
  const toggle = page.getByRole('button', { name: 'Toggle the Brush Settings panel' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(page.locator('.brush-settings')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  const airbrush = page.getByRole('button', { name: 'Airbrush-style build-up' });
  await airbrush.click();
  await expect(airbrush).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.brush-settings').getByRole('checkbox', { name: 'Build-up' })).toBeChecked();
  expect((await brush(page)).options.dynamics.buildUp).toBe(true);

  const angle = page.getByRole('textbox', { name: 'Brush angle' });
  await angle.fill('30');
  await angle.press('Enter');
  expect((await brush(page)).options.angle).toBe(30);
  await expect(page.locator('.brush-settings').getByRole('textbox', { name: 'Angle', exact: true })).toHaveValue('30°');
  // Spacing lives in Brush Settings now, not in the options bar.
  await expect(page.locator('.options-bar').getByRole('textbox', { name: 'Spacing:' })).toHaveCount(0);

  await toggle.click();
  await expect(page.locator('.brush-settings')).toHaveCount(0);
});

test('painting cursors follow Preferences > Cursors and are kept for next time', async ({ page }) => {
  await setBrush(page, { size: 40, hardness: 0 });
  const centre = await at(page, 48, 32);
  await page.mouse.move(centre.x, centre.y);
  // Normal Brush Tip (the default): no system cursor; the outline where a soft tip paints half (radius 10).
  await expect(canvas(page)).toHaveCSS('cursor', 'none');
  expect(await outlineNear(page, 58, 32)).toBeGreaterThan(100);
  expect(await outlineNear(page, 68, 32)).toBe(0);

  // Full Size Brush Tip: the outline at the full radius (20).
  let dialog = await openPreferences(page);
  await dialog.getByRole('tab', { name: 'Cursors' }).click();
  await dialog.getByRole('radio', { name: 'Full Size Brush Tip' }).check();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await page.mouse.move(centre.x + 1, centre.y);
  await page.mouse.move(centre.x, centre.y);
  expect(await outlineNear(page, 68, 32)).toBeGreaterThan(100);

  // Precise: the crosshair; Standard: the tool's icon.
  dialog = await openPreferences(page);
  await dialog.getByRole('tab', { name: 'Cursors' }).click();
  await dialog.getByRole('radio', { name: 'Precise' }).check();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(canvas(page)).toHaveCSS('cursor', 'crosshair');
  dialog = await openPreferences(page);
  await dialog.getByRole('tab', { name: 'Cursors' }).click();
  await dialog.getByRole('radio', { name: 'Standard' }).check();
  await dialog.getByRole('button', { name: 'Cancel' }).click(); // Cancel keeps Precise
  await expect(canvas(page)).toHaveCSS('cursor', 'crosshair');
  dialog = await openPreferences(page);
  await dialog.getByRole('tab', { name: 'Cursors' }).click();
  await dialog.getByRole('radio', { name: 'Standard' }).check();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(canvas(page)).toHaveCSS('cursor', /url\(/);

  // Kept after a reload.
  await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.services.preferences.saved());
  await page.reload();
  await page.getByTestId('app-root').waitFor();
  const saved = await page.evaluate(async () => {
    const prefs = (window as unknown as AppWindow).__pixelforge.services.preferences;
    await prefs.ready;
    return prefs.values.cursors.painting;
  });
  expect(saved).toBe('standard');
});

test('the brush HUD: drag sideways for the size, down for harder, with a preview and a readout', async ({ page }) => {
  await setBrush(page, { size: 20, hardness: 0.5 });
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  const start = await at(page, 48, 32);
  await page.mouse.move(start.x, start.y);
  // Alt+right-drag (Ctrl+Option-drag on macOS).
  if (mac) await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.mouse.down({ button: mac ? 'left' : 'right' });
  const zoomCss = await page.evaluate(() => {
    const c = (window as unknown as AppWindow).__pixelforge.canvas!;
    return c.context.viewport.zoom / c.renderer.devicePixelRatio;
  });
  // 5 document px to the right (+10 diameter), 20 CSS px down (+20 % hardness).
  await page.mouse.move(start.x + 5 * zoomCss, start.y + 20, { steps: 4 });
  let o = (await brush(page)).options;
  expect(o.size).toBe(30);
  expect(o.hardness).toBeCloseTo(0.7);
  // The HUD: the tip filled in the preview colour (red) where the pointer started.
  const [r = 0, g = 0, b = 0, a = 0] = await overlayAt(page, 48, 32);
  expect(a).toBeGreaterThan(60);
  expect(r).toBeGreaterThan(200);
  expect(g + b).toBeLessThan(60);
  // The options bar follows.
  await expect(page.getByRole('button', { name: 'Brush preset picker' })).toHaveText('30');
  await page.mouse.up({ button: mac ? 'left' : 'right' });
  await page.keyboard.up('Alt');
  if (mac) await page.keyboard.up('Control');
  expect((await overlayAt(page, 48, 32))[3]).toBe(0); // gone
  // Nothing was painted.
  await expect(page.getByRole('listbox', { name: 'History states' }).getByRole('option')).toHaveCount(1);

  // With "Vary round brush hardness" off, vertical drags change the opacity.
  const dialog = await openPreferences(page);
  await dialog.getByRole('checkbox', { name: /Vary round brush hardness/ }).uncheck();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await page.mouse.move(start.x, start.y);
  if (mac) await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.mouse.down({ button: mac ? 'left' : 'right' });
  await page.mouse.move(start.x, start.y - 30, { steps: 3 });
  await page.mouse.up({ button: mac ? 'left' : 'right' });
  await page.keyboard.up('Alt');
  if (mac) await page.keyboard.up('Control');
  o = (await brush(page)).options;
  expect(o.opacity).toBeCloseTo(0.7);
  expect(o.hardness).toBeCloseTo(0.7);
});

test('Brush Settings: the angle and roundness control, Spacing off, and Clear Brush Controls', async ({ page }) => {
  await page.keyboard.press('F5');
  const panel = page.locator('.brush-settings');
  const pose = panel.getByRole('slider', { name: 'Tip angle and roundness' });
  await pose.focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+ArrowDown');
  let o = (await brush(page)).options;
  expect(o.angle).toBe(11);
  expect(o.roundness).toBeCloseTo(0.9);
  await expect(panel.getByRole('textbox', { name: 'Roundness' })).toHaveValue('90%');

  await panel.getByRole('checkbox', { name: 'Use spacing' }).uncheck();
  await expect(panel.getByRole('textbox', { name: 'Spacing' })).toBeDisabled();
  expect((await brush(page)).options.spacingEnabled).toBe(false);

  await panel.getByRole('checkbox', { name: 'Use Shape Dynamics' }).check();
  await page.locator('.floating-panel').getByRole('button', { name: 'Panel menu' }).click();
  await page.getByRole('menuitem', { name: 'Clear Brush Controls' }).click();
  await expect(panel.getByRole('checkbox', { name: 'Use Shape Dynamics' })).not.toBeChecked();
  o = (await brush(page)).options;
  expect(o.angle).toBe(11); // the tip shape stays
});
