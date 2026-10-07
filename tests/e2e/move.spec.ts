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

async function drag(page: Page, from: [number, number], to: [number, number], hold: string[] = []) {
  const a = await at(page, ...from);
  const b = await at(page, ...to);
  for (const key of hold) await page.keyboard.down(key);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  for (const key of hold) await page.keyboard.up(key);
}

/** Layer names (top → bottom) with their offsets, once commands have finished. */
const layers = (page: Page) =>
  page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    return [...ws.active!.doc.root.children]
      .reverse()
      .map((l) => (l.kind === 'pixel' ? `${l.name} ${l.offsetX},${l.offsetY}` : l.name));
  });

test('dragging moves the selected layer; arrows nudge it; undo restores', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+J');
  await page.keyboard.press('v');
  await expect(page.locator('.toolbar [data-tool="move"]')).toHaveAttribute('aria-pressed', 'true');
  await drag(page, [20, 20], [30, 25]);
  await expect(history(page).last()).toHaveText('Move');
  expect(await layers(page)).toEqual(['Background copy 10,5', 'Background 0,0']);
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(history(page).last()).toHaveText('Nudge');
  expect(await layers(page)).toEqual(['Background copy 11,15', 'Background 0,0']);
  await page.keyboard.press('ControlOrMeta+Z');
  await page.keyboard.press('ControlOrMeta+Z');
  await page.keyboard.press('ControlOrMeta+Z');
  expect(await layers(page)).toEqual(['Background copy 0,0', 'Background 0,0']);
});

test('the Background cannot be moved', async ({ page }) => {
  await page.keyboard.press('v');
  await drag(page, [20, 20], [30, 25]);
  const dialog = page.getByRole('dialog', { name: 'Could not move' });
  await expect(dialog).toContainText('The Background layer cannot be moved');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(history(page)).toHaveText(['Open']);
});

test('Alt-drag duplicates the layer and moves the copy; Shift constrains', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+J');
  await page.keyboard.press('v');
  await drag(page, [20, 20], [40, 22], ['Alt']);
  expect(await layers(page)).toEqual(['Background copy 2 20,2', 'Background copy 0,0', 'Background 0,0']);
  await drag(page, [20, 20], [40, 23], ['Shift']); // mostly horizontal: vertical part dropped
  expect((await layers(page))[0]).toBe('Background copy 2 40,2');
});

test('with a selection, dragging inside it moves the selected pixels (and the outline)', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+J');
  const before = await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle(); // the duplicate is ready
    const doc = ws.active!.doc;
    return (doc.activeLayer as { buffer: { getPixel(x: number, y: number): number[] } }).buffer.getPixel(15, 15);
  });
  await page.keyboard.press('m');
  await drag(page, [10, 10], [30, 30]);
  await page.keyboard.press('v');
  await drag(page, [15, 15], [55, 25]);
  await expect(history(page).last()).toHaveText('Move');
  const result = await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    const doc = ws.active!.doc;
    const layer = doc.activeLayer as { buffer: { getPixel(x: number, y: number): number[] } };
    return {
      left: layer.buffer.getPixel(15, 15),
      arrived: layer.buffer.getPixel(55, 25),
      outline: doc.selection!.value(55, 25, doc.canvasRect),
    };
  });
  expect(result.left[3]).toBe(0);
  expect(result.arrived).toEqual(before);
  expect(result.outline).toBe(255);
});

test('Auto-Select picks the layer under the pointer; arrows move a selection outline with the marquee', async ({
  page,
}) => {
  // Top layer: a small opaque square; below it, the Background.
  await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.execute({ name: 'newLayer', params: { name: 'Square' } });
    await ws.execute({
      name: 'selectShape',
      params: { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 60, y: 40, w: 20, h: 20 } },
    });
    await ws.execute({ name: 'fill', params: { color: [255, 0, 0] } });
    await ws.execute({ name: 'deselect', params: {} });
  });
  await page.keyboard.press('v');
  await page.getByRole('checkbox', { name: 'Auto-Select:' }).check();
  await page.getByLabel('Document canvas').focus();
  await page.mouse.click(...(Object.values(await at(page, 10, 10)) as [number, number]));
  await expect(
    page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Background' }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.mouse.click(...(Object.values(await at(page, 70, 50)) as [number, number]));
  await expect(page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem', { name: 'Square' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await page.keyboard.press('m');
  await drag(page, [10, 10], [20, 20]);
  await expect(history(page).last()).toHaveText('Rectangular Marquee');
  await page.keyboard.press('ArrowRight');
  const value = await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    const doc = ws.active!.doc;
    return [doc.selection!.value(10, 15, doc.canvasRect), doc.selection!.value(20, 15, doc.canvasRect)];
  });
  expect(value).toEqual([0, 255]);
});

test('shortcuts wait while a dialog is open', async ({ page }) => {
  await page.keyboard.press('Shift+F5');
  await expect(page.getByRole('dialog', { name: 'Fill' })).toBeVisible();
  await page.keyboard.press('b');
  await expect(page.locator('.toolbar [data-tool="brush"]')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
});
