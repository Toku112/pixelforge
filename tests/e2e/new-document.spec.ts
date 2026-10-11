import { expect, test, type Page } from '@playwright/test';
import type { AppController } from '../../src/app/controller';

type AppWindow = { __pixelforge: AppController };

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('app-root').waitFor();
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

async function fileNew(page: Page) {
  await page.getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: 'New…' }).click();
  return page.getByRole('dialog', { name: 'New Document' });
}

/** The active document's size, mode, layers and History. */
const active = (page: Page) =>
  page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    const s = ws.active!;
    const doc = s.doc;
    const layer = doc.activeLayer as {
      name: string;
      isBackground: boolean;
      buffer: { getPixel(x: number, y: number): number[] };
    };
    return {
      name: doc.name,
      size: [doc.width, doc.height, doc.resolution],
      format: [doc.mode, doc.depth],
      layers: doc.root.children.map((l) => l.name),
      background: layer.isBackground,
      pixel: layer.buffer.getPixel(0, 0),
      history: s.history.entries.map((e) => e.label),
    };
  });

test('File > New makes a white 7 × 5 in, 300 ppi document named Untitled-1', async ({ page }) => {
  await page.getByRole('button', { name: 'New…' }).click(); // the start screen's button
  const dialog = page.getByRole('dialog', { name: 'New Document' });
  await expect(dialog.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('option', { name: /Default Size/ })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('textbox', { name: 'Document name' })).toHaveValue('Untitled-1');
  await expect(dialog.getByRole('textbox', { name: 'Width' })).toHaveValue('7');
  await expect(dialog.getByRole('textbox', { name: 'Height' })).toHaveValue('5');
  await expect(dialog.getByRole('combobox', { name: 'Size unit' })).toHaveValue('inches');
  await expect(dialog.getByRole('textbox', { name: 'Resolution' })).toHaveValue('300');
  await expect(dialog.getByRole('button', { name: 'Landscape' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog).toContainText('2100 × 1500 px');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('tab', { name: /Untitled-1/ })).toBeVisible();
  expect(await active(page)).toEqual({
    name: 'Untitled-1',
    size: [2100, 1500, 300],
    format: ['rgb', 8],
    layers: ['Background'],
    background: true,
    pixel: [255, 255, 255],
    history: ['New'],
  });
});

test('a preset, changed: other unit, portrait, Grayscale 16-bit, transparent; Recent remembers it', async ({
  page,
}) => {
  let dialog = await fileNew(page);
  await dialog.getByRole('tab', { name: 'Web' }).click();
  await dialog.getByRole('option', { name: /Web 1280 × 800/ }).click();
  await expect(dialog.getByRole('combobox', { name: 'Size unit' })).toHaveValue('pixels');
  // Inches show the same pixels.
  await dialog.getByRole('combobox', { name: 'Size unit' }).selectOption('inches');
  await expect(dialog.getByRole('textbox', { name: 'Width' })).toHaveValue('17.778');
  await expect(dialog).toContainText('1280 × 800 px');
  await expect(dialog.getByRole('option', { name: /Web 1280 × 800/ })).toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('combobox', { name: 'Size unit' }).selectOption('pixels');
  await dialog.getByRole('button', { name: 'Portrait' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Width' })).toHaveValue('800');
  await expect(dialog.getByRole('option', { name: /Web 1280 × 800/ })).toHaveAttribute('aria-selected', 'false');
  await dialog.getByRole('combobox', { name: 'Color mode' }).selectOption('grayscale');
  await dialog.getByRole('combobox', { name: 'Bit depth' }).selectOption('16');
  await dialog.getByRole('combobox', { name: 'Background contents' }).selectOption('transparent');
  await dialog.getByRole('textbox', { name: 'Document name' }).fill('Sketch');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('tab', { name: /Sketch/ })).toBeVisible();
  expect(await active(page)).toMatchObject({
    name: 'Sketch',
    size: [800, 1280, 72],
    format: ['grayscale', 16],
    layers: ['Layer 1'],
    background: false,
    pixel: [0, 0],
  });

  // The next document: still Untitled-1 (the name was changed), and Recent lists the custom size first.
  dialog = await fileNew(page);
  await expect(dialog.getByRole('textbox', { name: 'Document name' })).toHaveValue('Untitled-1');
  await expect(dialog.getByRole('listbox', { name: 'Recent presets' }).getByRole('option').first()).toHaveText(
    /Custom.*800 × 1280 px/,
  );
  await expect(dialog.getByRole('textbox', { name: 'Width' })).toHaveValue('800');
  await expect(dialog.getByRole('combobox', { name: 'Bit depth' })).toHaveValue('16');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
});

test('saving a document preset, and the background colour and a custom colour', async ({ page }) => {
  await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.colors.setBackground({ r: 0, g: 0.5, b: 1 }));
  const dialog = await fileNew(page);
  await dialog.getByRole('combobox', { name: 'Size unit' }).selectOption('pixels');
  await dialog.getByRole('textbox', { name: 'Width' }).fill('640');
  await dialog.getByRole('textbox', { name: 'Width' }).press('Tab');
  await dialog.getByRole('textbox', { name: 'Height' }).fill('480');
  await dialog.getByRole('textbox', { name: 'Height' }).press('Tab');
  await dialog.getByRole('combobox', { name: 'Background contents' }).selectOption('background');
  await dialog.getByRole('button', { name: 'Save document preset' }).click();
  const name = page.getByRole('dialog', { name: 'Save Document Preset' });
  await name.getByRole('textbox').fill('Small blue');
  await name.getByRole('button', { name: 'OK' }).click();
  await expect(dialog.getByRole('tab', { name: 'Saved' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('option', { name: /Small blue/ })).toHaveAttribute('aria-selected', 'true');

  // A custom colour from the Color Picker.
  await dialog.getByRole('combobox', { name: 'Background contents' }).selectOption('custom');
  const picker = page.getByRole('dialog', { name: /Custom Background Color/ });
  await picker.getByRole('textbox', { name: 'Hexadecimal colour' }).fill('ff8000');
  await picker.getByRole('textbox', { name: 'Hexadecimal colour' }).press('Enter');
  await picker.getByRole('button', { name: 'OK' }).click();
  await expect(dialog.getByRole('combobox', { name: 'Background contents' })).toHaveValue('custom');
  await dialog.getByRole('button', { name: 'Create' }).click();
  expect(await active(page)).toMatchObject({ size: [640, 480, 300], pixel: [255, 128, 0] });

  // The saved preset makes its document (background colour) with a double-click.
  const again = await fileNew(page);
  await again.getByRole('tab', { name: 'Saved' }).click();
  await again.getByRole('option', { name: /Small blue/ }).dblclick();
  await expect(page.getByRole('tab', { name: /Untitled-2/ })).toBeVisible();
  expect(await active(page)).toMatchObject({ name: 'Untitled-2', size: [640, 480, 300], pixel: [0, 128, 255] });

  // Deleting it.
  const third = await fileNew(page);
  await third.getByRole('tab', { name: 'Saved' }).click();
  await third.getByRole('option', { name: /Small blue/ }).click();
  await third.getByRole('button', { name: 'Delete saved preset' }).click();
  await expect(third.getByRole('listbox', { name: 'Saved presets' }).getByRole('option')).toHaveCount(0);
  await expect(third).toContainText('Presets you save');
});
