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
  // 400 %, centred: one document pixel is 4 device pixels.
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

/** Page coordinates of a document point. */
async function at(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
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

async function click(page: Page, x: number, y: number) {
  const p = await at(page, x, y);
  await page.mouse.click(p.x, p.y);
}

/** Selection value (0–255) at document points, once running commands have finished. */
const selected = (page: Page, points: [number, number][]) =>
  page.evaluate(async (pts) => {
    const workspace = (window as unknown as AppWindow).__pixelforge.workspace;
    await workspace.whenIdle();
    const doc = workspace.active!.doc;
    return pts.map(([x, y]) => doc.selection?.value(x, y, doc.canvasRect) ?? 0);
  }, points);

const tool = (page: Page, id: string) => page.locator(`.toolbar [data-tool="${id}"]`);

async function chooseTool(page: Page, groupTool: string, name: RegExp) {
  await tool(page, groupTool).click({ button: 'right' });
  await page.getByRole('menuitemradio', { name }).click();
}

test('marquee: draw, deselect, reselect, inverse, select all — each a history step', async ({ page }) => {
  await page.keyboard.press('m');
  await expect(tool(page, 'marquee-rect')).toHaveAttribute('aria-pressed', 'true');
  await drag(page, [10, 10], [40, 30]);
  await expect(history(page).last()).toHaveText('Rectangular Marquee');
  expect(
    await selected(page, [
      [10, 10],
      [39, 29],
      [40, 30],
      [5, 5],
    ]),
  ).toEqual([255, 255, 0, 0]);
  // The marching ants trace the rectangle.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as AppWindow).__pixelforge.canvas!.selectionOverlay!.outline?.map((l) => [...l]),
      ),
    )
    .toEqual([[10, 10, 40, 10, 40, 30, 10, 30]]);

  await page.keyboard.press('ControlOrMeta+D');
  expect(await selected(page, [[20, 20]])).toEqual([0]);
  await page.keyboard.press('ControlOrMeta+Shift+D');
  expect(await selected(page, [[20, 20]])).toEqual([255]);
  await page.keyboard.press('ControlOrMeta+Shift+I');
  expect(
    await selected(page, [
      [20, 20],
      [60, 50],
    ]),
  ).toEqual([0, 255]);
  await page.keyboard.press('ControlOrMeta+A');
  expect(
    await selected(page, [
      [20, 20],
      [95, 63],
    ]),
  ).toEqual([255, 255]);
  await expect(history(page)).toHaveText([
    'Open',
    'Rectangular Marquee',
    'Deselect',
    'Reselect',
    'Inverse',
    'Select All',
  ]);
  // A click with the marquee deselects.
  await click(page, 50, 50);
  expect(await selected(page, [[20, 20]])).toEqual([0]);
});

test('marquee modifiers: Shift adds, Alt subtracts, Shift+Alt intersects; dragging inside moves the outline', async ({
  page,
}) => {
  await page.keyboard.press('m');
  await drag(page, [0, 0], [30, 30]);
  await drag(page, [50, 30], [70, 50], ['Shift']);
  expect(
    await selected(page, [
      [10, 10],
      [60, 40],
    ]),
  ).toEqual([255, 255]);
  await drag(page, [5, 5], [15, 15], ['Alt']);
  expect(
    await selected(page, [
      [10, 10],
      [20, 20],
    ]),
  ).toEqual([0, 255]);
  await drag(page, [0, 0], [25, 25], ['Shift', 'Alt']);
  expect(
    await selected(page, [
      [20, 20],
      [60, 40],
      [27, 27],
    ]),
  ).toEqual([255, 0, 0]);
  // Drag inside the selection: the outline moves by whole pixels.
  await drag(page, [20, 20], [30, 25]);
  await expect(history(page).last()).toHaveText('Move Selection');
  expect(
    await selected(page, [
      [19, 18],
      [29, 23],
    ]),
  ).toEqual([0, 255]);
});

test('marquee while dragging: Shift squares, Alt draws from the centre (taking effect at once)', async ({ page }) => {
  await page.keyboard.press('m');
  const a = await at(page, 20, 20);
  const b = await at(page, 50, 30);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.keyboard.down('Shift'); // pressed after the drag started: constrain, without moving
  await page.mouse.up();
  await page.keyboard.up('Shift');
  // A 30 × 30 square from (20, 20).
  expect(
    await selected(page, [
      [49, 49],
      [49, 50],
      [50, 25],
    ]),
  ).toEqual([255, 0, 0]);

  await page.keyboard.press('ControlOrMeta+D');
  const c = await at(page, 60, 40);
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  await page.mouse.move(c.x, c.y, { steps: 4 });
  await page.keyboard.down('Alt'); // from the centre: (40, 20)–(60, 40)
  await page.mouse.up();
  await page.keyboard.up('Alt');
  expect(
    await selected(page, [
      [40, 20],
      [59, 39],
      [60, 40],
      [39, 30],
    ]),
  ).toEqual([255, 255, 0, 0]);
});

test('elliptical marquee with feather from the options bar gives soft edges', async ({ page }) => {
  await chooseTool(page, 'marquee-rect', /Elliptical Marquee/);
  const feather = page.getByRole('textbox', { name: 'Feather:' });
  await feather.fill('3');
  await feather.press('Enter');
  await page.getByLabel('Document canvas').focus();
  await drag(page, [20, 10], [70, 50]);
  await expect(history(page).last()).toHaveText('Elliptical Marquee');
  const [centre, edge, outside] = await selected(page, [
    [45, 30],
    [20, 30],
    [5, 5],
  ]);
  expect(centre).toBe(255);
  expect(edge).toBeGreaterThan(30);
  expect(edge).toBeLessThan(225);
  expect(outside).toBe(0);
});

test('lasso and polygonal lasso (Enter closes, Backspace removes a corner, Escape cancels)', async ({ page }) => {
  await page.keyboard.press('l');
  await expect(tool(page, 'lasso')).toHaveAttribute('aria-pressed', 'true');
  const pts: [number, number][] = [
    [10, 10],
    [40, 10],
    [40, 40],
    [10, 40],
  ];
  const first = await at(page, ...pts[0]!);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const p of pts.slice(1)) {
    const s = await at(page, ...p);
    await page.mouse.move(s.x, s.y, { steps: 5 });
  }
  await page.mouse.up();
  await expect(history(page).last()).toHaveText('Lasso');
  expect(
    await selected(page, [
      [25, 25],
      [50, 25],
    ]),
  ).toEqual([255, 0]);

  await page.keyboard.press('Shift+L');
  await expect(tool(page, 'polygonal-lasso')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+D');
  await click(page, 50, 10);
  await click(page, 90, 10);
  await click(page, 90, 60);
  await click(page, 70, 60); // removed again below
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await expect(history(page).last()).toHaveText('Polygonal Lasso');
  expect(
    await selected(page, [
      [80, 20],
      [60, 50],
    ]),
  ).toEqual([255, 0]); // a triangle (50,10)-(90,10)-(90,60)

  await click(page, 10, 10);
  await click(page, 30, 10);
  await page.keyboard.press('Escape');
  await expect(history(page).last()).toHaveText('Polygonal Lasso'); // nothing new
  // The polygon was abandoned, so Delete is free to clear pixels again.
});

test('Invert and Delete work through the selection; Delete without one deletes the layer', async ({ page }) => {
  const pixel = (x: number, y: number) =>
    page.evaluate(
      async ([px, py]) => {
        const workspace = (window as unknown as AppWindow).__pixelforge.workspace;
        await workspace.whenIdle();
        const layer = workspace.active!.doc.activeLayer as { buffer: { getPixel(x: number, y: number): number[] } };
        return layer.buffer.getPixel(px!, py!);
      },
      [x, y],
    );
  await page.keyboard.press('ControlOrMeta+J'); // a normal layer with the image
  await page.keyboard.press('m');
  await drag(page, [10, 10], [30, 30]);
  const inside = await pixel(20, 20);
  const outside = await pixel(50, 50);
  await page.keyboard.press('ControlOrMeta+I');
  expect(await pixel(20, 20)).toEqual([255 - inside[0]!, 255 - inside[1]!, 255 - inside[2]!, 255]);
  expect(await pixel(50, 50)).toEqual(outside);
  await page.keyboard.press('Delete');
  await expect(history(page).last()).toHaveText('Clear');
  expect((await pixel(20, 20))[3]).toBe(0);
  expect((await pixel(50, 50))[3]).toBe(255);
  await page.keyboard.press('ControlOrMeta+D');
  await page.keyboard.press('Backspace');
  await expect(page.getByRole('tree', { name: 'Layers' }).getByRole('treeitem')).toHaveText(['Background']);
});

test('single row and column marquees select a 1-pixel line across the canvas', async ({ page }) => {
  await chooseTool(page, 'marquee-rect', /Single Row/);
  await click(page, 30.5, 20.5);
  await expect(history(page).last()).toHaveText('Single Row Marquee');
  expect(
    await selected(page, [
      [0, 20],
      [95, 20],
      [30, 21],
    ]),
  ).toEqual([255, 255, 0]);
  await chooseTool(page, 'marquee-row', /Single Column/);
  await click(page, 40.5, 5.5);
  expect(
    await selected(page, [
      [40, 63],
      [0, 20],
    ]),
  ).toEqual([255, 0]); // a new selection replaced the row
});
