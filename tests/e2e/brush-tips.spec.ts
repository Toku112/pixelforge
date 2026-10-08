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

/** Canvas-page position of a document point. */
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

/** The active layer's pixel at a document point, once work has finished. */
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

/** What the last History step recorded. */
const lastDescriptor = (page: Page) =>
  page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    const h = ws.active!.history;
    return h.descriptorOf(h.entries.at(-1)!.id);
  });

async function newLayer(page: Page) {
  await page.keyboard.press('ControlOrMeta+Alt+Shift+N');
  await page.getByLabel('Document canvas').focus();
}

test('a pen stroke records pressure, tilt and barrel rotation', async ({ page }) => {
  await newLayer(page);
  await page.keyboard.press('b');
  // The samples as they come (no smoothing or curves in between).
  await page.evaluate(() => {
    const brush = (window as unknown as AppWindow).__pixelforge.tools.byId.get('brush') as unknown as {
      setSmoothing(o: { amount: number; curves: boolean }): void;
    };
    brush.setSmoothing({ amount: 0, curves: false });
  });
  const a = await at(page, 20, 20);
  const b = await at(page, 60, 30);
  // Synthetic pen events (Playwright's mouse has no pen properties).
  await page.evaluate(
    ([from, to]) => {
      const canvas = document.querySelector('[aria-label="Document canvas"]')!;
      const send = (type: string, x: number, y: number, pressure: number) =>
        canvas.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 7,
            pointerType: 'pen',
            isPrimary: true,
            bubbles: true,
            clientX: x,
            clientY: y,
            button: type === 'pointermove' ? -1 : 0,
            buttons: type === 'pointerup' ? 0 : 1,
            pressure,
            tiltX: 30,
            tiltY: -15,
            twist: 90,
            // The same tilt as altitude/azimuth, for engines that use those (WebKit).
            ...{ altitudeAngle: Math.atan(1 / Math.hypot(Math.tan(Math.PI / 6), Math.tan(-Math.PI / 12))) },
            ...{ azimuthAngle: Math.atan2(Math.tan(-Math.PI / 12), Math.tan(Math.PI / 6)) + 2 * Math.PI },
          }),
        );
      send('pointerdown', from!.x, from!.y, 0.4);
      send('pointermove', (from!.x + to!.x) / 2, (from!.y + to!.y) / 2, 0.7);
      send('pointerup', to!.x, to!.y, 0);
    },
    [a, b],
  );
  await expect(page.getByRole('listbox', { name: 'History states' }).getByRole('option').last()).toHaveText(
    'Brush Tool',
  );
  const d = (await lastDescriptor(page)) as unknown as { params: { points: number[]; stride: number } };
  expect(d.params.stride).toBe(8);
  // x, y, pressure, tiltX, tiltY, twist, wheel, time
  // (The browser keeps pressure in single precision: 0.4 arrives as 0.4000000059….)
  expect(d.params.points[2]).toBeCloseTo(0.4, 6);
  expect(d.params.points[3]).toBeCloseTo(30, 3);
  expect(d.params.points[4]).toBeCloseTo(-15, 3);
  expect(d.params.points[5]).toBe(90);
  expect(d.params.points[10]).toBeCloseTo(0.7, 6);
});

test('blend-mode shortcuts set the Brush mode; Multiply paints through', async ({ page }) => {
  await page.keyboard.press('b');
  await page.getByLabel('Document canvas').focus();
  const mode = page.getByRole('combobox', { name: 'Brush mode' });
  await expect(mode).toHaveValue('normal');
  await page.keyboard.press('Alt+Shift+M');
  await expect(mode).toHaveValue('multiply');
  await page.keyboard.press('Shift+Equal');
  await expect(mode).toHaveValue('color-burn');
  // Behind and Clear need transparency: greyed out on the Background.
  await expect(mode.locator('option[value="behind"]')).toHaveAttribute('disabled', '');
  await mode.selectOption('multiply');
  // White paint in Multiply changes nothing; the layer's blend mode stayed Normal.
  await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.colors.setForeground({ r: 1, g: 1, b: 1 }));
  const before = await pixel(page, 30, 30);
  const p = await at(page, 30, 30);
  await page.mouse.click(p.x, p.y);
  expect(await pixel(page, 30, 30)).toEqual(before);
  const layerMode = await page.evaluate(
    () => (window as unknown as AppWindow).__pixelforge.workspace.active!.doc.activeLayer!.blendMode,
  );
  expect(layerMode).toBe('normal');
});

test('Define Brush Preset makes a tip from the selection that paints its shape and is kept', async ({ page }) => {
  // A black bar 20 × 4 on a new layer over the photo.
  await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.execute({ name: 'newLayer', params: { name: 'Bar' } });
    await ws.execute({
      name: 'selectShape',
      params: { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 10, y: 10, w: 20, h: 4 } },
    });
    await ws.execute({ name: 'fill', params: { color: [0, 0, 0] } });
    // Select the bar on a white Background: hide the photo by filling the Background white.
    await ws.execute({ name: 'deselect', params: {} });
  });
  await page.evaluate(async () => {
    const c = (window as unknown as AppWindow).__pixelforge;
    const ws = c.workspace;
    const doc = ws.active!.doc;
    doc.setActiveLayer(doc.background!.id);
    await ws.execute({ name: 'fill', params: { color: [255, 255, 255] } });
    await ws.execute({
      name: 'selectShape',
      params: { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 5, y: 5, w: 30, h: 14 } },
    });
  });
  await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Edit' }).click();
  await page.getByRole('menuitem', { name: /^Define Brush Preset/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Brush Name' });
  await expect(dialog).toContainText('30 × 14');
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Bar tip');
  await dialog.getByRole('button', { name: 'OK' }).click();

  // The Brush tool now uses it, at its own size.
  await page.keyboard.press('b');
  const picker = page.getByRole('button', { name: 'Brush preset picker' });
  await expect(picker).toHaveText('30');
  await picker.click();
  await expect(page.getByRole('option', { name: 'Bar tip' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');

  // One dab: a 20 × 4 bar (scaled 1:1) centred where we click, not a disc.
  await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.execute({ name: 'deselect', params: {} });
    await ws.execute({ name: 'newLayer', params: { name: 'Paint' } });
  });
  await page.getByLabel('Document canvas').focus();
  const p = await at(page, 50.5, 40.5);
  await page.mouse.click(p.x, p.y);
  expect((await pixel(page, 50, 40))[3]).toBe(255);
  expect((await pixel(page, 58, 40))[3]).toBe(255); // along the bar
  expect((await pixel(page, 50, 44))[3]).toBe(0); // 4 px below: outside the 4 px bar

  // Kept for next time (IndexedDB): still listed after a reload.
  await page.reload();
  await page.getByTestId('app-root').waitFor();
  const names = await page.evaluate(async () => {
    const lib = (window as unknown as AppWindow).__pixelforge.services.brushes;
    await lib.ready;
    return lib.list().map((t) => [t.name, t.width, t.height]);
  });
  expect(names).toContainEqual(['Bar tip', 30, 14]);
});

test('the brush picker sets angle and roundness: an elliptical, turned dab', async ({ page }) => {
  await newLayer(page);
  await page.keyboard.press('b');
  await page.getByRole('button', { name: 'Brush preset picker' }).click();
  const panel = page.getByRole('group', { name: 'Brush settings' });
  for (const [name, value] of [
    ['Size', '20'],
    ['Roundness', '25'],
    ['Angle', '90'],
  ] as const) {
    const field = panel.getByRole('textbox', { name });
    await field.fill(value);
    await field.press('Enter');
  }
  await page.keyboard.press('Escape');
  await page.getByLabel('Document canvas').focus();
  const p = await at(page, 48.5, 32.5);
  await page.mouse.click(p.x, p.y);
  expect((await pixel(page, 48, 25))[3]).toBe(255); // 7 px up: inside the tall ellipse
  expect((await pixel(page, 53, 32))[3]).toBe(0); // 5 px right: outside (it is 5 px wide)
});
