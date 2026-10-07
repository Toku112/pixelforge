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
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.addInitScript(() => {
    Object.assign(window, { showOpenFilePicker: undefined, showSaveFilePicker: undefined });
  });
  await page.goto('/');
  await page.getByTestId('app-root').waitFor();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+O');
  await (await chooser).setFiles(join(FIXTURES, 'rgb8.png'));
  await expect(page.getByRole('tab', { name: /rgb8\.png/ })).toBeVisible();
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

const tree = (page: Page) => page.getByRole('tree', { name: 'Layers' });
const row = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true });
const history = (page: Page) => page.getByRole('listbox', { name: 'History states' }).getByRole('option');

/** Layer state from the document: name, visibility, blend mode, opacity — top to bottom as shown. */
const layers = (page: Page) =>
  page.evaluate(() => {
    const doc = (window as unknown as AppWindow).__pixelforge.workspace.active!.doc;
    return [...doc.layers()]
      .reverse()
      .map((l) => ({ name: l.name, visible: l.visible, mode: l.blendMode, opacity: l.opacity }));
  });

const selectedNames = (page: Page) =>
  page.evaluate(() => {
    const doc = (window as unknown as AppWindow).__pixelforge.workspace.active!.doc;
    return doc.selectedLayerIds.map((id) => doc.requireLayer(id).name);
  });

/** Drags a row to a fraction of another row's height (0 = top edge, 1 = bottom edge). */
async function dragRow(page: Page, from: string, to: string, fraction: number) {
  const a = (await row(page, from).boundingBox())!;
  const b = (await row(page, to).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * fraction, { steps: 8 });
  await page.mouse.up();
}

test('lists layers; new layer and group buttons, rename, visibility and solo', async ({ page }) => {
  await expect(tree(page).getByRole('treeitem')).toHaveText(['Background']);
  await page.getByRole('button', { name: 'New layer' }).click();
  await page.getByRole('button', { name: 'New layer' }).click();
  await expect(tree(page).getByRole('treeitem')).toHaveText(['Layer 2', 'Layer 1', 'Background']);
  await expect(row(page, 'Layer 2')).toHaveAttribute('aria-selected', 'true');

  // Rename by double-clicking the name.
  await row(page, 'Layer 1').getByText('Layer 1').dblclick();
  await page.getByRole('textbox', { name: 'Layer name' }).fill('Sky');
  await page.keyboard.press('Enter');
  await expect(tree(page).getByRole('treeitem')).toHaveText(['Layer 2', 'Sky', 'Background']);
  // Escape cancels a rename.
  await row(page, 'Sky').getByText('Sky').dblclick();
  await page.getByRole('textbox', { name: 'Layer name' }).fill('Nope');
  await page.keyboard.press('Escape');
  await expect(row(page, 'Sky')).toBeVisible();

  // Eye: hide; Alt-click: show only that layer, then restore.
  await page.getByRole('button', { name: 'Visibility of Layer 2' }).click();
  expect((await layers(page)).map((l) => l.visible)).toEqual([false, true, true]);
  await page.getByRole('button', { name: 'Visibility of Sky' }).click({ modifiers: ['Alt'] });
  expect((await layers(page)).map((l) => l.visible)).toEqual([false, true, false]);
  await page.getByRole('button', { name: 'Visibility of Sky' }).click({ modifiers: ['Alt'] });
  expect((await layers(page)).map((l) => l.visible)).toEqual([false, true, true]);
  await expect(history(page)).toHaveText([
    'Open',
    'New Layer',
    'New Layer',
    'Rename Layer',
    'Hide Layer',
    'Hide Layer',
    'Show Layer',
  ]);

  // New group goes above the active layer; collapsing hides its contents.
  await row(page, 'Sky').click();
  await page.getByRole('button', { name: 'New group' }).click();
  await expect(tree(page).getByRole('treeitem')).toHaveText(['Layer 2', 'Group 1', 'Sky', 'Background']);
});

test('drag to reorder, into and out of groups; never below the Background', async ({ page }) => {
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'New layer' }).click();
  await row(page, 'Layer 1').click();
  await page.getByRole('button', { name: 'New group' }).click(); // above Layer 1
  await expect(tree(page).getByRole('treeitem')).toHaveText(['Layer 3', 'Layer 2', 'Group 1', 'Layer 1', 'Background']);

  await dragRow(page, 'Layer 3', 'Group 1', 0.5); // onto the middle of the group: inside
  await expect(tree(page).getByRole('treeitem')).toHaveText(['Layer 2', 'Group 1', 'Layer 3', 'Layer 1', 'Background']);
  await expect(row(page, 'Layer 3')).toHaveAttribute('aria-level', '2');

  await dragRow(page, 'Layer 1', 'Layer 2', 0.1); // above Layer 2
  await expect(tree(page).getByRole('treeitem')).toHaveText(['Layer 1', 'Layer 2', 'Group 1', 'Layer 3', 'Background']);

  await dragRow(page, 'Layer 3', 'Layer 2', 0.1); // out of the group
  await expect(row(page, 'Layer 3')).toHaveAttribute('aria-level', '1');

  await dragRow(page, 'Layer 2', 'Background', 0.9); // below the Background: refused
  await expect(tree(page).getByRole('treeitem').last()).toHaveText('Background');
  await expect(history(page).last()).toHaveText('Layer Order');

  // Collapse and expand the group with its triangle.
  await page.getByRole('button', { name: 'Collapse Group 1' }).click();
  await expect(row(page, 'Group 1')).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Expand Group 1' }).click();
  await expect(row(page, 'Group 1')).toHaveAttribute('aria-expanded', 'true');
});

test('multi-select with Shift and Ctrl/Cmd; blend mode, opacity and fill apply to all selected', async ({ page }) => {
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'New layer' }).click();
  await row(page, 'Layer 3').click();
  await row(page, 'Layer 1').click({ modifiers: ['Shift'] });
  expect((await selectedNames(page)).sort()).toEqual(['Layer 1', 'Layer 2', 'Layer 3']);
  await row(page, 'Layer 2').click({ modifiers: ['ControlOrMeta'] });
  expect((await selectedNames(page)).sort()).toEqual(['Layer 1', 'Layer 3']);

  await page.getByRole('combobox', { name: 'Blend mode' }).selectOption('screen');
  await page.getByRole('textbox', { name: 'Opacity' }).fill('40');
  await page.keyboard.press('Enter');
  const fill = page.getByRole('textbox', { name: 'Fill' });
  await fill.fill('*0.5');
  await page.keyboard.press('Enter');
  const state = await layers(page);
  expect(state.map((l) => [l.name, l.mode, l.opacity])).toEqual([
    ['Layer 3', 'screen', 0.4],
    ['Layer 2', 'normal', 1],
    ['Layer 1', 'screen', 0.4],
    ['Background', 'normal', 1],
  ]);
  await expect(fill).toHaveValue('50%');
  await expect(history(page).last()).toHaveText('Fill Opacity');

  // The Background alone: blend mode and opacity are fixed.
  await row(page, 'Background').click();
  await expect(page.getByRole('combobox', { name: 'Blend mode' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Opacity' })).toBeDisabled();
});

test('scrubbing Opacity previews live and records one step', async ({ page }) => {
  await page.getByRole('button', { name: 'New layer' }).click();
  const label = page.locator('.layers-controls .number-field-label', { hasText: 'Opacity' });
  const box = (await label.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2, { steps: 5 });
  expect((await layers(page))[0]!.opacity).toBeCloseTo(0.8, 2);
  await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2, { steps: 3 });
  await page.mouse.up();
  expect((await layers(page))[0]!.opacity).toBeCloseTo(0.7, 2);
  await expect(history(page)).toHaveText(['Open', 'New Layer', 'Layer Opacity']);
  await page.keyboard.press('ControlOrMeta+Z');
  expect((await layers(page))[0]!.opacity).toBe(1);
});

test('locks: buttons toggle per layer; a locked layer cannot change mode or be deleted', async ({ page }) => {
  await page.getByRole('button', { name: 'New layer' }).click();
  const lockAll = page.getByRole('button', { name: 'Lock all' });
  await lockAll.click();
  await expect(lockAll).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('combobox', { name: 'Blend mode' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete layer' })).toBeDisabled();
  await lockAll.click();
  await page.getByRole('button', { name: 'Lock position' }).click();
  await expect(page.getByRole('button', { name: 'Lock position' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('combobox', { name: 'Blend mode' })).toBeEnabled();
  await row(page, 'Background').click();
  await expect(lockAll).toBeDisabled();
});

test('dialogs: New Layer (Alt-click), Group…, Duplicate Layer…, Layer from Background…', async ({ page }) => {
  await page.getByRole('button', { name: 'New layer' }).click({ modifiers: ['Alt'] });
  const dialog = page.getByRole('dialog', { name: 'New Layer' });
  await expect(dialog.getByLabel('Name')).toHaveValue('Layer 1');
  await dialog.getByLabel('Name').fill('Shadows');
  await dialog.getByLabel('Mode').selectOption('multiply');
  await dialog.getByRole('textbox', { name: 'Opacity' }).fill('50');
  await dialog.getByRole('button', { name: 'OK' }).click();
  expect((await layers(page))[0]).toEqual({ name: 'Shadows', visible: true, mode: 'multiply', opacity: 0.5 });

  // Cancel leaves everything as it was.
  await page.getByRole('button', { name: 'New group' }).click({ modifiers: ['Alt'] });
  await page.getByRole('dialog', { name: 'New Group' }).getByRole('button', { name: 'Cancel' }).click();
  expect(await layers(page)).toHaveLength(2);

  // Layer > Duplicate Layer…
  await page.getByRole('menuitem', { name: 'Layer' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate Layer…' }).click();
  const dup = page.getByRole('dialog', { name: 'Duplicate Layer' });
  await expect(dup.getByLabel('As')).toHaveValue('Shadows copy');
  await dup.getByLabel('As').fill('Shadows 2');
  await page.keyboard.press('Enter');
  expect((await layers(page)).map((l) => l.name)).toEqual(['Shadows 2', 'Shadows', 'Background']);

  // Double-click the Background's name: convert it (New Layer dialog named "Layer 0").
  await row(page, 'Background').getByText('Background').dblclick();
  const convert = page.getByRole('dialog', { name: 'New Layer' });
  await expect(convert.getByLabel('Name')).toHaveValue('Layer 0');
  await convert.getByRole('button', { name: 'OK' }).click();
  await expect(tree(page).getByRole('treeitem').last()).toHaveText('Layer 0');
  await expect(history(page).last()).toHaveText('Layer From Background');
});

test('delete asks first (unless Alt-click or "Don\'t show again")', async ({ page }) => {
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'New layer' }).click();
  const trash = page.getByRole('button', { name: 'Delete layer' });
  await trash.click();
  const ask = page.getByRole('dialog', { name: 'Delete' });
  await expect(ask).toContainText('Delete the layer “Layer 3”?');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  expect(await layers(page)).toHaveLength(4);
  await trash.click({ modifiers: ['Alt'] });
  expect((await layers(page)).map((l) => l.name)).toEqual(['Layer 2', 'Layer 1', 'Background']);
  await trash.click();
  await ask.getByLabel('Don’t show again').check();
  await ask.getByRole('button', { name: 'Delete' }).click();
  await trash.click(); // no question any more
  expect((await layers(page)).map((l) => l.name)).toEqual(['Background']);
});

test('keyboard: arrows select, Shift+arrows extend, Enter renames, Delete deletes', async ({ page }) => {
  for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'New layer' }).click();
  await row(page, 'Layer 2').click();
  await page.keyboard.press('ArrowDown');
  expect(await selectedNames(page)).toEqual(['Layer 1']);
  await page.keyboard.press('Shift+ArrowUp');
  expect((await selectedNames(page)).sort()).toEqual(['Layer 1', 'Layer 2']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Renamed');
  await page.keyboard.press('Enter');
  await expect(row(page, 'Renamed')).toBeVisible();
  await tree(page).focus();
  await page.keyboard.press('Delete');
  await expect(tree(page).getByRole('treeitem')).toHaveText(['Layer 2', 'Background']);
});

test('thumbnails show each layer and follow edits', async ({ page }) => {
  // Average colour of a row's thumbnail.
  const thumbColor = (name: string) =>
    row(page, name)
      .getByTestId('layer-thumbnail')
      .evaluate((canvas: HTMLCanvasElement) => {
        const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
        const sum = [0, 0, 0, 0];
        for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 4; c++) sum[c]! += data[i + c]!;
        return sum.map((v) => Math.round(v / (data.length / 4)));
      });
  const background = row(page, 'Background').getByTestId('layer-thumbnail');
  await expect(background).toHaveAttribute('data-ready', 'true');
  const before = await thumbColor('Background');
  expect(before[3]).toBe(255);

  await page.keyboard.press('ControlOrMeta+I'); // Invert the Background
  await expect.poll(async () => (await thumbColor('Background'))[0]).toBeCloseTo(255 - before[0]!, -1);

  await page.getByRole('button', { name: 'New layer' }).click();
  await expect(row(page, 'Layer 1').getByTestId('layer-thumbnail')).toHaveAttribute('data-ready', 'true');
  expect((await thumbColor('Layer 1'))[3]).toBe(0); // empty layer: transparent
});

test('F7 and Window > Layers show and hide the panel; Layer > Rename Layer… edits the name', async ({ page }) => {
  await page.keyboard.press('F7');
  await expect(page.getByRole('tab', { name: 'Layers' })).toHaveCount(0);
  await page.keyboard.press('F7');
  await expect(tree(page)).toBeVisible();
  await page.getByRole('button', { name: 'New layer' }).click();
  await page.getByRole('menuitem', { name: 'Layer' }).click();
  await page.getByRole('menuitem', { name: 'Rename Layer…' }).click();
  await page.getByRole('textbox', { name: 'Layer name' }).fill('From menu');
  await page.keyboard.press('Enter');
  await expect(row(page, 'From menu')).toBeVisible();
});

/** Rendered colour at the centre of the canvas. */
const centrePixel = (page: Page) =>
  page.evaluate(() => {
    const r = (window as unknown as AppWindow).__pixelforge.canvas!.renderer;
    while (!r.render());
    const data = r.readCanvas();
    const i = (Math.floor(r.canvas.height / 2) * r.canvas.width + Math.floor(r.canvas.width / 2)) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  });

const near = (a: (number | undefined)[], b: (number | undefined)[]) => a.every((v, i) => Math.abs(v! - b[i]!) <= 2);

test('merge: Merge Down / Merge Layers (Ctrl/Cmd+E), Merge Visible, Stamp Visible keep the picture', async ({
  page,
}) => {
  // Two layers with content: duplicates of the Background, the top one inverted at 50 %.
  await page.keyboard.press('ControlOrMeta+J');
  await page.keyboard.press('ControlOrMeta+J');
  await page.keyboard.press('ControlOrMeta+I');
  const opacity = page.getByRole('textbox', { name: 'Opacity' });
  await opacity.fill('50');
  await opacity.press('Enter');
  await tree(page).focus();
  const look = await centrePixel(page);

  await page.getByRole('menuitem', { name: 'Layer' }).click();
  await expect(page.getByRole('menuitem', { name: /^Merge Down/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+E');
  await expect(tree(page).getByRole('treeitem')).toHaveText(['Background copy', 'Background']);
  await expect(history(page).last()).toHaveText('Merge Down');
  expect(near(await centrePixel(page), look)).toBe(true);

  // Select both: the menu says Merge Layers; merging includes the Background → one Background.
  await row(page, 'Background').click({ modifiers: ['Shift'] });
  await page.getByRole('menuitem', { name: 'Layer' }).click();
  await expect(page.getByRole('menuitem', { name: /^Merge Layers/ })).toBeVisible();
  await page.getByRole('menuitem', { name: /^Merge Layers/ }).click();
  await expect(tree(page).getByRole('treeitem')).toHaveText(['Background']);
  expect(near(await centrePixel(page), look)).toBe(true);

  // Stamp Visible, then Merge Visible.
  await page.keyboard.press('ControlOrMeta+Alt+Shift+E');
  await expect(tree(page).getByRole('treeitem')).toHaveText(['Layer 1', 'Background']);
  await expect(history(page).last()).toHaveText('Stamp Visible');
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await expect(tree(page).getByRole('treeitem')).toHaveText(['Background']);
  await expect(history(page).last()).toHaveText('Merge Visible');
  expect(near(await centrePixel(page), look)).toBe(true);
});

test('Flatten Image asks before discarding hidden layers; Background from Layer', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+J');
  await page.getByRole('button', { name: 'Visibility of Background copy' }).click();
  await page.getByRole('menuitem', { name: 'Layer' }).click();
  await page.getByRole('menuitem', { name: 'Flatten Image' }).click();
  const ask = page.getByRole('dialog', { name: 'Flatten Image' });
  await expect(ask).toContainText('Discard hidden layers?');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(tree(page).getByRole('treeitem')).toHaveCount(2);
  await page.getByRole('menuitem', { name: 'Layer' }).click();
  await page.getByRole('menuitem', { name: 'Flatten Image' }).click();
  await ask.getByRole('button', { name: 'OK' }).click();
  await expect(tree(page).getByRole('treeitem')).toHaveText(['Background']);

  // Make the Background a layer, add one above, then turn that one into the Background.
  await row(page, 'Background').getByText('Background').dblclick();
  await page.getByRole('dialog', { name: 'New Layer' }).getByRole('button', { name: 'OK' }).click();
  await page.getByRole('button', { name: 'New layer' }).click();
  await page.getByRole('menuitem', { name: 'Layer' }).click();
  await page.getByRole('menuitem', { name: 'New', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Background from Layer' }).click();
  await expect(tree(page).getByRole('treeitem')).toHaveText(['Layer 0', 'Background']);
  await expect(history(page).last()).toHaveText('Background From Layer');
});
