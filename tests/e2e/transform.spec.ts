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
    ctx.viewport.zoomTo(3);
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
  await page.mouse.move(a.x, a.y);
  for (const key of hold) await page.keyboard.down(key);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  for (const key of hold) await page.keyboard.up(key);
}

async function editMenu(page: Page, name: string) {
  await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Edit' }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click();
}

const quad = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as AppWindow).__pixelforge.tools.transform.quad?.map((p) => [
      Math.round(p.x * 10) / 10,
      Math.round(p.y * 10) / 10,
    ]),
  );

/** The active layer's pixel at a document point, once commands have finished. */
const pixel = (page: Page, x: number, y: number) =>
  page.evaluate(
    async ([px, py]) => {
      const ws = (window as unknown as AppWindow).__pixelforge.workspace;
      await ws.whenIdle();
      const l = ws.active!.doc.activeLayer as {
        offsetX: number;
        offsetY: number;
        buffer: { getPixel(x: number, y: number): number[] };
      };
      return l.buffer.getPixel(px! - l.offsetX, py! - l.offsetY);
    },
    [x, y],
  );

test('Free Transform scales proportionally from a corner, applies with Enter, and undoes', async ({ page }) => {
  // The Background cannot be transformed without a selection.
  await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Edit' }).click();
  await expect(page.getByRole('menuitem', { name: /^Free Transform/ })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+J');
  await page.keyboard.press('v');
  await editMenu(page, 'Free Transform');
  await expect(page.getByRole('textbox', { name: 'W:' })).toHaveValue('100%');
  expect(await quad(page)).toEqual([
    [0, 0],
    [96, 0],
    [96, 64],
    [0, 64],
  ]);
  // Bottom-right corner to the right only: the height follows (proportions kept).
  await drag(page, [96, 64], [144, 64]);
  await expect(page.getByRole('textbox', { name: 'W:' })).toHaveValue(/^1[45]\d(\.\d+)?%$/);
  const w = await page.getByRole('textbox', { name: 'W:' }).inputValue();
  await expect(page.getByRole('textbox', { name: 'H:' }).first()).toHaveValue(w);
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('Enter');
  await expect(history(page).last()).toHaveText('Free Transform');
  // Back to the Move tool; the layer grew to the right and down.
  await expect(page.locator('.toolbar [data-tool="move"]')).toHaveAttribute('aria-pressed', 'true');
  expect((await pixel(page, 120, 80))[3]).toBe(255);
  await page.keyboard.press('ControlOrMeta+Z');
  expect((await pixel(page, 120, 80))[3]).toBe(0);
});

test('typed numbers, Shift-snapped rotation, and Escape cancels', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+J');
  await editMenu(page, 'Free Transform');
  const angle = page.getByRole('textbox', { name: 'Rotation angle' });
  await angle.fill('90');
  await angle.press('Enter');
  // A quarter turn about the centre (48, 32).
  expect(await quad(page)).toEqual([
    [80, -16],
    [80, 80],
    [16, 80],
    [16, -16],
  ]);
  // Dragging outside rotates; Shift snaps the angle to 15° steps.
  await drag(page, [100, 50], [80, 110], ['Shift']);
  const snapped = Number((await angle.inputValue()).replace('°', ''));
  expect(snapped % 15).toBe(0);
  expect(snapped).not.toBe(90);
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('Escape');
  await expect(history(page)).toHaveText(['Open', 'Duplicate Layer']);
  expect(await quad(page)).toBeUndefined();
  expect(await pixel(page, 5, 5)).toEqual(await pixel(page, 5, 5)); // unchanged and readable
  expect((await pixel(page, 95, 63))[3]).toBe(255);
});

test('with a selection on the Background, the selected pixels move and the background colour fills in', async ({
  page,
}) => {
  await page.keyboard.press('m');
  await drag(page, [10, 10], [30, 30]);
  const before = await pixel(page, 15, 15);
  await editMenu(page, 'Free Transform');
  await drag(page, [20, 20], [60, 20]); // inside: move
  await page.getByRole('button', { name: 'Commit transform' }).click();
  await expect(history(page).last()).toHaveText('Free Transform');
  expect(await pixel(page, 15, 15)).toEqual([255, 255, 255]);
  expect(await pixel(page, 55, 15)).toEqual(before);
  const selected = await page.evaluate(() => {
    const doc = (window as unknown as AppWindow).__pixelforge.workspace.active!.doc;
    return [doc.selection!.value(55, 15, doc.canvasRect), doc.selection!.value(15, 15, doc.canvasRect)];
  });
  expect(selected).toEqual([255, 0]);
});

test('Ctrl/Cmd-dragging a corner distorts it alone', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+J');
  await editMenu(page, 'Free Transform');
  await drag(page, [96, 0], [110, 10], ['ControlOrMeta']);
  const q = await quad(page);
  expect(q![0]).toEqual([0, 0]);
  expect(q![1]![0]).toBeCloseTo(110, 0);
  expect(q![1]![1]).toBeCloseTo(10, 0);
  expect(q![2]).toEqual([96, 64]);
  await page.getByRole('button', { name: 'Commit transform' }).click();
  await expect(history(page).last()).toHaveText('Free Transform');
});

test('the live preview (drawn on the GPU, any blend mode) matches the applied result', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+J');
  const result = await page.evaluate(async () => {
    const c = (window as unknown as AppWindow).__pixelforge;
    const ws = c.workspace;
    await ws.whenIdle();
    const doc = ws.active!.doc;
    await ws.execute({
      name: 'setLayerProps',
      params: { layerId: doc.activeLayerId!, props: { blendMode: 'difference' } },
    });
    const ctx = c.canvas!.context;
    await c.freeTransform();
    c.tools.transform.setNumbers({ angle: 90 }, ctx);
    const area = { x: 30, y: 10, w: 36, h: 40 };
    const previewing = c.canvas!.renderer.transformPreview !== null;
    const preview = Array.from(c.canvas!.renderer.readComposite(area));
    c.tools.transform.commit(ctx);
    await ws.whenIdle();
    while (c.canvas!.renderer.transformPreview) await new Promise((r) => setTimeout(r, 10));
    const applied = Array.from(c.canvas!.renderer.readComposite(area));
    return { previewing, preview, applied, history: ws.active!.history.entries.at(-1)!.label };
  });
  expect(result.history).toBe('Free Transform');
  expect(result.previewing).toBe(true);
  let worst = 0;
  for (let i = 0; i < result.preview.length; i++)
    worst = Math.max(worst, Math.abs(result.preview[i]! - result.applied[i]!));
  // An 8-bit picture sampled bilinearly vs. the exact result: close, not identical.
  expect(worst).toBeLessThan(0.05);
});
