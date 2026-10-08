import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { AppController } from '../../src/app/controller';
import { bool, deg, dyn, obj, pct, px, text, writeAbr } from '../unit/io/abr-writer';

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
  await (await chooser).setFiles(join(FIXTURES, 'photo.jpg'));
  await expect(page.getByRole('tab', { name: /photo\.jpg/ })).toBeVisible();
  await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.services.brushes.ready);
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('b');
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

const brush = (page: Page) =>
  page.evaluate(() => {
    const t = (window as unknown as AppWindow).__pixelforge.tools.brush;
    return { options: JSON.parse(JSON.stringify(t.options)) as Record<string, unknown>, presetId: t.presetId };
  });

async function openBrushes(page: Page) {
  const panel = page.locator('.brushes-panel');
  // The workspace remembers open panels (also across reloads): the menu item would close it.
  if (await panel.isVisible()) return panel;
  await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Brushes', exact: true }).click();
  await expect(panel).toBeVisible();
  return panel;
}

const presets = (panel: ReturnType<Page['locator']>) => panel.getByRole('listbox', { name: 'Brush presets' });

async function answerName(page: Page, title: string, name: string) {
  const dialog = page.getByRole('dialog', { name: title });
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
  await dialog.getByRole('button', { name: 'OK' }).click();
}

test('our default brushes: choosing one sets the brush, remembers it, and paints with it', async ({ page }) => {
  const panel = await openBrushes(page);
  for (const group of ['General Brushes', 'Dry Media', 'Wet Media', 'Special Effects'])
    await expect(presets(panel).getByRole('group', { name: group })).toBeVisible();
  await presets(panel).getByRole('option', { name: 'Charcoal' }).click();
  const b = await brush(page);
  expect(b.options).toMatchObject({ tip: 'pf-tip-charcoal', size: 40 });
  expect(b.presetId).toBe('pf-charcoal');
  await expect(presets(panel).getByRole('option', { name: 'Charcoal' })).toHaveAttribute('aria-selected', 'true');
  await expect(
    panel.getByRole('listbox', { name: 'Recent brushes' }).getByRole('option', { name: 'Charcoal' }),
  ).toBeVisible();
  // The picker lists the same presets.
  await page.getByRole('button', { name: 'Brush preset picker' }).click();
  const picker = page.getByRole('group', { name: 'Brush settings' });
  await expect(
    picker.getByRole('listbox', { name: 'Brush presets' }).getByRole('option', { name: 'Ink Pen' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // Searching.
  await panel.getByRole('searchbox', { name: 'Search brushes' }).fill('ink');
  await expect(presets(panel).getByRole('option')).toHaveCount(1);
  await expect(presets(panel).getByRole('option')).toHaveText(/Ink Pen/);
  await panel.getByRole('searchbox', { name: 'Search brushes' }).fill('');

  // Painting uses the charcoal tip (recorded with the stroke).
  await page.keyboard.press('ControlOrMeta+Alt+Shift+N');
  await page.getByLabel('Document canvas').focus();
  const box = (await page.getByLabel('Document canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const recorded = await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    const h = ws.active!.history;
    return h.descriptorOf(h.entries.at(-1)!.id) as unknown as { params: { brush: { tip: string } } };
  });
  expect(recorded.params.brush.tip).toBe('pf-tip-charcoal');
});

test('making, grouping, renaming and deleting presets; they are kept for next time', async ({ page }) => {
  const panel = await openBrushes(page);
  await presets(panel).getByRole('option', { name: 'Hard Round', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Size:' }).fill('77');
  await panel.getByRole('textbox', { name: 'Size:' }).press('Enter');
  await panel.getByRole('button', { name: 'New brush preset' }).click();
  await answerName(page, 'New Brush Preset', 'Big Round');
  // In the group of the brush it was made from, and selected.
  const general = presets(panel).getByRole('group', { name: 'General Brushes' });
  await expect(general.getByRole('option', { name: 'Big Round' })).toHaveAttribute('aria-selected', 'true');

  await panel.getByRole('button', { name: 'New brush group' }).click();
  await answerName(page, 'New Brush Group', 'Mine');
  const mine = presets(panel).getByRole('group', { name: 'Mine' });
  // Drag it onto the group (HTML drag and drop, as the panel's list handles it).
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await general.getByRole('option', { name: 'Big Round' }).dispatchEvent('dragstart', { dataTransfer: transfer });
  const header = mine.getByRole('button', { name: 'Mine' });
  await header.dispatchEvent('dragover', { dataTransfer: transfer });
  await header.dispatchEvent('drop', { dataTransfer: transfer });
  await expect(mine.getByRole('option', { name: 'Big Round' })).toBeVisible();

  await mine.getByRole('option', { name: 'Big Round' }).dblclick();
  await answerName(page, 'Rename Brush', 'Very Big Round');
  await expect(mine.getByRole('option', { name: 'Very Big Round' })).toBeVisible();

  // Kept after a reload.
  await page.reload();
  await page.getByTestId('app-root').waitFor();
  const saved = await page.evaluate(async () => {
    const lib = (window as unknown as AppWindow).__pixelforge.services.brushes;
    await lib.ready;
    return lib.presets().find((p) => p.name === 'Very Big Round');
  });
  expect(saved).toMatchObject({ group: 'Mine', brush: { size: 77 } });

  // Deleting (after choosing it).
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('b');
  const again = await openBrushes(page);
  await presets(again).getByRole('option', { name: 'Very Big Round' }).click();
  await again.getByRole('button', { name: 'Delete brush' }).click();
  await page.getByRole('dialog', { name: 'Delete Brush' }).getByRole('button', { name: 'Delete' }).click();
  await expect(presets(again).getByRole('option', { name: 'Very Big Round' })).toHaveCount(0);
});

test('export a group to our brush file and import it back; import an .abr file', async ({ page }) => {
  const panel = await openBrushes(page);
  await presets(panel).getByRole('option', { name: 'Ink Pen' }).click();
  await page.locator('.floating-panel').getByRole('button', { name: 'Panel menu' }).click();
  await page.getByRole('menuitem', { name: 'Export Brushes…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export Brushes' });
  await expect(dialog.getByRole('checkbox', { name: 'Wet Media' })).toBeChecked();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Wet Media.pfbrush');
  const bytes = await readFile(await file.path());
  const json = JSON.parse(bytes.toString('utf8')) as { presets: { name: string }[] };
  expect(json.presets.map((p) => p.name)).toEqual(['Watercolor Wash', 'Ink Pen', 'Flat Gouache', 'Dry Bristle']);

  // Delete the group, then import the file: the brushes come back.
  await page.locator('.floating-panel').getByRole('button', { name: 'Panel menu' }).click();
  await page.getByRole('menuitem', { name: 'Delete Group…' }).click();
  await page.getByRole('dialog', { name: 'Delete Brush Group' }).getByRole('button', { name: 'Delete' }).click();
  await expect(presets(panel).getByRole('group', { name: 'Wet Media' })).toHaveCount(0);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.floating-panel').getByRole('button', { name: 'Panel menu' }).click();
  await page.getByRole('menuitem', { name: 'Import Brushes…' }).click();
  await (await chooser).setFiles({ name: 'Wet Media.pfbrush', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(presets(panel).getByRole('group', { name: 'Wet Media' }).getByRole('option')).toHaveCount(4);

  // An .abr file: a sampled tip with pen-pressure size.
  const abr = writeAbr(
    [{ id: '$t', width: 4, height: 4, data: new Uint8Array(16).fill(255) }],
    [
      obj('Brsh', {
        'Nm  ': text('Square Stamp'),
        Brsh: obj('sampledBrush', {
          Dmtr: px(16),
          Angl: deg(0),
          Rndn: pct(100),
          Intr: bool(true),
          Spcn: pct(25),
          flipX: bool(false),
          flipY: bool(false),
          'Nm  ': text('square'),
          sampledData: text('$t'),
        }),
        Spcn: pct(25),
        Wtdg: bool(false),
        Nose: bool(false),
        useBrushSize: bool(true),
        useTipDynamics: bool(true),
        szVr: dyn(2),
        angleDynamics: dyn(0),
        roundnessDynamics: dyn(0),
        tiltScale: pct(0),
        minimumDiameter: pct(0),
        minimumRoundness: pct(25),
        flipX: bool(false),
        flipY: bool(false),
        brushProjection: bool(false),
      }),
    ],
  );
  const abrChooser = page.waitForEvent('filechooser');
  await page.locator('.floating-panel').getByRole('button', { name: 'Panel menu' }).click();
  await page.getByRole('menuitem', { name: 'Import Brushes…' }).click();
  await (
    await abrChooser
  ).setFiles({ name: 'Stamps.abr', mimeType: 'application/octet-stream', buffer: Buffer.from(abr) });
  const stamps = presets(panel).getByRole('group', { name: 'Stamps' });
  await stamps.getByRole('option', { name: 'Square Stamp' }).click();
  const b = await brush(page);
  expect(b.options).toMatchObject({ size: 16 });
  expect(String(b.options['tip'])).toMatch(/\$t$/);
  expect((b.options['dynamics'] as { shape: { size: { control: string } } }).shape.size.control).toBe('pressure');
});

test('Protect Texture keeps the texture when switching presets; Restore Default Brushes', async ({ page }) => {
  const panel = await openBrushes(page);
  await presets(panel).getByRole('option', { name: 'Charcoal' }).click();
  await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.tools.brush.setProtectTexture(true));
  await presets(panel).getByRole('option', { name: 'Soft Pastel' }).click();
  const b = await brush(page);
  expect(b.options['tip']).toBe('pf-tip-chalk');
  expect((b.options['dynamics'] as { texture: { pattern: string } }).texture.pattern).toBe('pf-rough-paper');

  // Delete a default brush, then restore the defaults.
  await presets(panel).getByRole('option', { name: 'Dotted Line' }).click();
  await panel.getByRole('button', { name: 'Delete brush' }).click();
  await page.getByRole('dialog', { name: 'Delete Brush' }).getByRole('button', { name: 'Delete' }).click();
  await expect(presets(panel).getByRole('option', { name: 'Dotted Line' })).toHaveCount(0);
  await page.locator('.floating-panel').getByRole('button', { name: 'Panel menu' }).click();
  await page.getByRole('menuitem', { name: 'Restore Default Brushes…' }).click();
  await page.getByRole('dialog', { name: 'Restore Default Brushes' }).getByRole('button', { name: 'Restore' }).click();
  await expect(presets(panel).getByRole('option', { name: 'Dotted Line' })).toBeVisible();
});

test('tool presets: a marquee with its feather, chosen from the Tool Presets panel', async ({ page }) => {
  await page.keyboard.press('m');
  await page.evaluate(() => {
    const c = (window as unknown as AppWindow).__pixelforge;
    (c.tools.marqueeRect as unknown as { setOptions(o: object): void }).setOptions({ feather: 5 });
  });
  await page.getByRole('button', { name: 'Tool preset picker' }).click();
  await page.getByRole('group', { name: 'Tool presets' }).getByRole('button', { name: 'New tool preset' }).click();
  await answerName(page, 'New Tool Preset', 'Soft Marquee');
  await expect(
    page.getByRole('group', { name: 'Tool presets' }).getByRole('option', { name: /Soft Marquee/ }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // Elsewhere, with other settings…
  await page.evaluate(() => {
    const c = (window as unknown as AppWindow).__pixelforge;
    (c.tools.marqueeRect as unknown as { setOptions(o: object): void }).setOptions({ feather: 0 });
  });
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('b');
  // …the panel brings the marquee back with its feather.
  await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Tool Presets' }).click();
  await page
    .locator('.tool-presets-panel')
    .getByRole('option', { name: /Soft Marquee/ })
    .click();
  const state = await page.evaluate(() => {
    const c = (window as unknown as AppWindow).__pixelforge;
    return {
      tool:
        c.canvas!.context &&
        (c as unknown as { tools: { marqueeRect: { options: { feather: number } } } }).tools.marqueeRect.options
          .feather,
    };
  });
  expect(state.tool).toBe(5);
  await expect(page.getByRole('button', { name: 'Tool preset picker' })).toHaveAttribute(
    'title',
    /Rectangular Marquee/,
  );
});
