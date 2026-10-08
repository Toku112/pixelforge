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
    ctx.viewport.zoomTo(4 * c.canvas!.renderer.devicePixelRatio);
    ctx.viewport.centerX = 48;
    ctx.viewport.centerY = 32;
    ctx.viewChanged();
  });
  await page.keyboard.press('ControlOrMeta+Alt+Shift+N');
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('b');
  await page.evaluate(() => {
    const brush = (window as unknown as AppWindow).__pixelforge.tools.byId.get('brush') as unknown as {
      setOptions(o: object): void;
      setSmoothing(o: object): void;
    };
    brush.setOptions({ size: 4, hardness: 1 });
    brush.setSmoothing({ amount: 0, curves: false });
  });
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

const alpha = (page: Page, x: number, y: number) =>
  page.evaluate(
    async ([px, py]) => {
      const ws = (window as unknown as AppWindow).__pixelforge.workspace;
      await ws.whenIdle();
      const l = ws.active!.doc.activeLayer as { buffer: { getPixel(x: number, y: number): number[] } };
      return l.buffer.getPixel(px!, py!)[3]!;
    },
    [x, y],
  );

const symmetry = (page: Page) =>
  page.evaluate(() => (window as unknown as AppWindow).__pixelforge.workspace.active!.doc.symmetry);

const historyLabels = (page: Page) =>
  page.getByRole('listbox', { name: 'History states' }).getByRole('option').allTextContents();

async function choose(page: Page, label: string) {
  await page.getByRole('button', { name: 'Paint symmetry' }).click();
  await page.getByRole('menu', { name: 'Paint symmetry' }).getByRole('menuitemcheckbox', { name: label }).click();
}

async function click(page: Page, x: number, y: number) {
  const p = await at(page, x + 0.5, y + 0.5);
  await page.mouse.click(p.x, p.y);
}

test('Vertical symmetry: placed and applied, then strokes paint their mirror image', async ({ page }) => {
  await choose(page, 'Vertical');
  await expect(page.getByRole('button', { name: 'Apply symmetry placement' })).toBeVisible();
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Apply symmetry placement' })).toHaveCount(0);
  expect(await symmetry(page)).toMatchObject({ kind: 'vertical', cx: 48, cy: 32, enabled: true });
  // Back on the Brush.
  await expect(page.getByRole('button', { name: 'Paint symmetry' })).toBeVisible();

  await click(page, 20, 20);
  expect(await alpha(page, 20, 20)).toBe(255);
  expect(await alpha(page, 75, 20)).toBe(255); // mirrored across x = 48
  expect(await alpha(page, 48, 20)).toBe(0);
  expect(await historyLabels(page)).toEqual(['Open', 'New Layer', 'New Symmetry', 'Brush Tool']);
  const recorded = await page.evaluate(() => {
    const h = (window as unknown as AppWindow).__pixelforge.workspace.active!.history;
    return h.descriptorOf(h.entries.at(-1)!.id) as unknown as { params: { symmetry?: { kind: string } } };
  });
  expect(recorded.params.symmetry?.kind).toBe('vertical');

  // Undo the stroke and the symmetry.
  await page.keyboard.press('ControlOrMeta+Z');
  await page.keyboard.press('ControlOrMeta+Z');
  expect(await symmetry(page)).toBeNull();
});

test('Radial asks for segments; moving the guide, hiding it and turning it off', async ({ page }) => {
  await choose(page, 'Radial…');
  const dialog = page.getByRole('dialog', { name: 'Radial Symmetry' });
  const count = dialog.getByRole('textbox', { name: 'Segment Count:' });
  await count.fill('4');
  await dialog.getByRole('button', { name: 'OK' }).click();
  // Move the guide 8 px left, then apply.
  const from = await at(page, 60, 40);
  const to = await at(page, 52, 40);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Apply symmetry placement' }).click();
  expect(await symmetry(page)).toMatchObject({ kind: 'radial', segments: 4, cx: 40, cy: 32 });
  expect((await historyLabels(page)).slice(-2)).toEqual(['New Symmetry', 'Transform Symmetry']);

  // Four copies a quarter turn apart around (40, 32): the click's centre (50.5, 32.5) turns to
  // (40.5, 21.5), (29.5, 31.5) and (39.5, 42.5).
  await page.getByLabel('Document canvas').focus();
  await click(page, 50, 32);
  for (const [x, y] of [
    [50, 32],
    [40, 21],
    [29, 31],
    [39, 42],
  ])
    expect(await alpha(page, x!, y!), `${x}, ${y}`).toBe(255);

  // Hidden, the guide is not drawn; painting still mirrors.
  await choose(page, 'Hide Symmetry');
  expect(await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.symmetryHidden)).toBe(true);
  await click(page, 40, 8); // (40.5, 8.5) → half a turn → (39.5, 55.5)
  expect(await alpha(page, 39, 55)).toBe(255);

  // Turned off: no more mirrors.
  await choose(page, 'Turn Off Symmetry');
  expect((await symmetry(page))?.enabled).toBe(false);
  await click(page, 12, 52);
  expect(await alpha(page, 12, 52)).toBe(255);
  expect(await alpha(page, 68, 12)).toBe(0);
});
