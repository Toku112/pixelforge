import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { AppController } from '../../src/app/controller';
import { builtInPattern } from '../../src/core/pattern/pattern';
import { readPat } from '../../src/io/pat';

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
  await page.evaluate(async () => {
    const c = (window as unknown as AppWindow).__pixelforge;
    await c.services.patterns.ready;
    const ctx = c.canvas!.context;
    ctx.viewport.zoomTo(4 * c.canvas!.renderer.devicePixelRatio); // 4 CSS px per image px
    ctx.viewport.centerX = 48;
    ctx.viewport.centerY = 32;
    ctx.viewChanged();
  });
  await page.getByLabel('Document canvas').focus();
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

const run = (page: Page, name: string, params: Record<string, unknown>) =>
  page.evaluate(
    ([n, p]) => (window as unknown as AppWindow).__pixelforge.workspace.execute({ name: n, params: p as never }),
    [name, params] as const,
  );

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

/** The active layer's pixel. */
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

async function openPatterns(page: Page) {
  await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Patterns' }).click();
  return page.locator('.floating-panel');
}

/** Paints a 2 × 2 checker of red and blue at the top left and defines it as a pattern named "Check". */
async function defineCheck(page: Page) {
  await run(page, 'selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 0, y: 0, w: 2, h: 2 } });
  await run(page, 'fill', { color: [255, 0, 0] });
  for (const [x, y] of [
    [1, 0],
    [0, 1],
  ]) {
    await run(page, 'selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x, y, w: 1, h: 1 } });
    await run(page, 'fill', { color: [0, 0, 255] });
  }
  await run(page, 'selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 0, y: 0, w: 2, h: 2 } });
  await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Edit' }).click();
  await page.getByRole('menuitem', { name: 'Define Pattern…' }).click();
  const name = page.getByRole('dialog', { name: 'Pattern Name' });
  await name.getByRole('textbox').fill('Check');
  await name.getByRole('button', { name: 'OK' }).click();
  await run(page, 'deselect', {});
}

test('Define Pattern makes a pattern from a sharp rectangle (and refuses other selections)', async ({ page }) => {
  await run(page, 'selectShape', {
    tool: 'elliptical-marquee',
    shape: { kind: 'ellipse', x: 10, y: 10, w: 20, h: 20 },
  });
  await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Edit' }).click();
  await page.getByRole('menuitem', { name: 'Define Pattern…' }).click();
  const refused = page.getByRole('dialog', { name: 'Could not define the pattern' });
  await expect(refused).toContainText('rectangular selection');
  await refused.getByRole('button', { name: 'OK' }).click();

  await defineCheck(page);
  const panel = await openPatterns(page);
  const check = panel.getByRole('option', { name: 'Check' });
  await expect(check).toHaveAttribute('aria-selected', 'true');
  const stored = await page.evaluate(() => {
    const c = (window as unknown as AppWindow).__pixelforge;
    const p = c.services.patterns.get(c.currentPatternId!)!;
    return { w: p.width, h: p.height, data: [...p.data] };
  });
  expect(stored).toEqual({ w: 2, h: 2, data: [255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255] });
});

test('the Pattern Stamp (S) paints the pattern, aligned to the image or from each stroke', async ({ page }) => {
  await defineCheck(page);
  await page.keyboard.press('ControlOrMeta+Alt+Shift+N'); // a new layer
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('s');
  await expect(page.getByRole('button', { name: 'Tool preset picker' })).toHaveAttribute('title', /Pattern Stamp Tool/);
  await page.evaluate(() =>
    (window as unknown as AppWindow).__pixelforge.tools.patternStamp.setOptions({ size: 9, hardness: 1 }),
  );
  await page.evaluate(() =>
    (window as unknown as AppWindow).__pixelforge.tools.patternStamp.setSmoothing({ amount: 0 }),
  );
  const a = await at(page, 30.5, 30.5);
  await page.mouse.click(a.x, a.y);
  await expect(history(page).last()).toHaveText('Pattern Stamp');
  // Aligned: the pattern repeats from the image's top left (even columns and rows red).
  expect(await pixel(page, 30, 30)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 31, 30)).toEqual([0, 0, 255, 255]);
  expect(await pixel(page, 31, 31)).toEqual([255, 0, 0, 255]);

  // Not aligned: the pattern starts where the stroke starts.
  await page.getByRole('checkbox', { name: 'Aligned' }).uncheck();
  await page.getByLabel('Document canvas').focus();
  const b = await at(page, 61.5, 30.5);
  await page.mouse.click(b.x, b.y);
  expect(await pixel(page, 61, 30)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 62, 30)).toEqual([0, 0, 255, 255]);

  // The picker chooses another pattern for the stamp.
  await page.getByRole('button', { name: 'Pattern Stamp pattern' }).click();
  await page.getByRole('group', { name: 'Patterns' }).getByRole('option', { name: 'Dots' }).click();
  expect(
    await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.tools.patternStamp.stamp.patternId),
  ).toBe('pf-dots');
});

test('Edit > Fill with a pattern', async ({ page }) => {
  await page.keyboard.press('Shift+F5');
  const dialog = page.getByRole('dialog', { name: 'Fill' });
  await dialog.getByRole('combobox').first().selectOption('pattern');
  await dialog.getByRole('button', { name: 'Custom pattern' }).click();
  await dialog.getByRole('option', { name: 'Dots' }).click();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(history(page).last()).toHaveText('Fill');
  const dots = builtInPattern('pf-dots')!;
  const expected = (x: number, y: number) => [
    ...dots.data.slice(((y % 16) * 16 + (x % 16)) * 4, ((y % 16) * 16 + (x % 16)) * 4 + 3),
  ];
  expect(await pixel(page, 8, 8)).toEqual(expected(8, 8));
  expect(await pixel(page, 40, 3)).toEqual(expected(40, 3));
});

test('the Patterns panel exports and imports .pat files, deletes and restores patterns', async ({ page }) => {
  await defineCheck(page);
  const panel = await openPatterns(page);
  await panel.getByRole('button', { name: 'Panel menu' }).click();
  await page.getByRole('menuitem', { name: 'Export Selected Patterns…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export Patterns' });
  await expect(dialog.getByRole('checkbox', { name: 'Textures' })).toBeChecked();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Textures.pat');
  const bytes = await readFile(await file.path());
  expect(readPat(new Uint8Array(bytes)).patterns.map((p) => p.name)).toContain('Check');

  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Panel menu' }).click();
  await page.getByRole('menuitem', { name: 'Import Patterns…' }).click();
  await (await chooser).setFiles({ name: 'Textures.pat', mimeType: 'application/octet-stream', buffer: bytes });
  const imported = panel.getByRole('group', { name: 'Textures 2' });
  await expect(imported.getByRole('option')).toHaveCount(7);

  // Deleting a default pattern hides it; Restore Default Patterns brings it back.
  const textures = panel.getByRole('group', { name: 'Textures', exact: true });
  await textures.getByRole('option', { name: 'Grain' }).click();
  await panel.getByRole('button', { name: 'Delete pattern' }).click();
  await expect(textures.getByRole('option', { name: 'Grain' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Panel menu' }).click();
  await page.getByRole('menuitem', { name: 'Restore Default Patterns…' }).click();
  await page.getByRole('dialog', { name: 'Restore Default Patterns' }).getByRole('button', { name: 'Restore' }).click();
  await expect(textures.getByRole('option', { name: 'Grain' })).toHaveCount(1);
  await expect(textures.getByRole('option', { name: 'Check' })).toHaveCount(1); // the user's pattern stays

  // Kept after a reload.
  await page.waitForTimeout(200);
  await page.reload();
  await page.getByTestId('app-root').waitFor();
  const groups = await page.evaluate(async () => {
    const lib = (window as unknown as AppWindow).__pixelforge.services.patterns;
    await lib.ready;
    return lib.groups().map((g) => [g.name, g.patterns.length]);
  });
  expect(groups).toEqual([
    ['Textures', 7],
    ['Textures 2', 7],
  ]);
});
