import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { APP_NAME } from '../../src/app/brand';
import type { AppController } from '../../src/app/controller';

type AppWindow = { __pixelforge: AppController };

const FIXTURES = join(import.meta.dirname, '../fixtures/images');

// Native file dialogs cannot be driven by tests: use the file-input and download fallbacks.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { showOpenFilePicker: undefined, showSaveFilePicker: undefined });
  });
  await page.goto('/');
  await page.getByTestId('app-root').waitFor();
});

async function openFile(page: Page, name: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+O');
  await (await chooser).setFiles(join(FIXTURES, name));
  await expect(page.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) })).toBeVisible();
}

/** View state and a rendered pixel, read from the running app. */
const app = (page: Page) =>
  page.evaluate(() => {
    const c = (window as unknown as AppWindow).__pixelforge;
    const r = c.canvas!.renderer;
    const v = r.viewport;
    return {
      zoom: v.zoom,
      rotation: v.rotation,
      centerX: v.centerX,
      centerY: v.centerY,
      dpr: r.devicePixelRatio,
      docs: c.workspace.sessions.length,
    };
  });

/** Colour of the canvas at a CSS point (relative to the canvas). */
const canvasPixel = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      const c = (window as unknown as AppWindow).__pixelforge;
      const r = c.canvas!.renderer;
      while (!r.render());
      const data = r.readCanvas();
      const i = (Math.floor(py! * r.devicePixelRatio) * r.canvas.width + Math.floor(px! * r.devicePixelRatio)) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    },
    [x, y],
  );

test('Phase 0 exit criteria: open a PNG, view it, pan/zoom/rotate, undo and redo a command', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await expect(page).toHaveTitle(APP_NAME);

  // Open a PNG and see it on the WebGL canvas.
  await openFile(page, 'tiles-rgba8.png');
  const canvas = page.getByLabel('Document canvas');
  const box = (await canvas.boundingBox())!;
  const center = { x: box.width / 2, y: box.height / 2 };
  const before = await canvasPixel(page, center.x, center.y);
  expect(before).not.toEqual([40, 40, 40]); // not the empty pasteboard
  const opened = await app(page);
  expect(opened.zoom).toBe(1); // small images open at 100 %

  // Zoom with the keyboard and with Alt + wheel at the pointer.
  await page.keyboard.press('ControlOrMeta+=');
  expect((await app(page)).zoom).toBe(2);
  await page.keyboard.press('ControlOrMeta+=');
  expect((await app(page)).zoom).toBe(3);
  await page.mouse.move(box.x + center.x, box.y + center.y);
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await app(page)).zoom).toBeGreaterThan(3);

  // Pan with Space + drag.
  const z = await app(page);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(box.x + center.x + 30, box.y + center.y + 20, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const panned = await app(page);
  expect(panned.centerX).toBeCloseTo(z.centerX - (30 * z.dpr) / z.zoom, 1);

  // Rotate the view with the Rotate View tool (R).
  await page.keyboard.press('r');
  await expect(page.getByRole('button', { name: 'Rotate View Tool' })).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(box.x + center.x + 150, box.y + center.y);
  await page.mouse.down();
  await page.mouse.move(box.x + center.x, box.y + center.y + 150, { steps: 6 });
  await page.mouse.up();
  expect((await app(page)).rotation).toBeCloseTo(90, 0);
  await page.getByRole('button', { name: 'Reset View' }).click();
  expect((await app(page)).rotation).toBe(0);

  // Run a command (Invert), then undo and redo it.
  await page.keyboard.press('ControlOrMeta+0'); // Fit on Screen
  const original = await canvasPixel(page, center.x, center.y);
  await page.keyboard.press('ControlOrMeta+I');
  const history = page.getByRole('listbox', { name: 'History states' });
  await expect(history.getByRole('option')).toHaveText(['Open', 'Invert']);
  const inverted = await canvasPixel(page, center.x, center.y);
  expect(inverted).toEqual(original.map((v) => 255 - v!));
  await expect(page.getByRole('tab', { name: /tiles-rgba8\.png.*\*\)/ })).toBeVisible(); // unsaved changes

  await page.keyboard.press('ControlOrMeta+Z');
  expect(await canvasPixel(page, center.x, center.y)).toEqual(original);
  await expect(history.getByRole('option', { name: 'Invert' })).toHaveClass(/future/);
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  expect(await canvasPixel(page, center.x, center.y)).toEqual(inverted);
  // Clicking a history state jumps there.
  await history.getByRole('option', { name: 'Open' }).click();
  expect(await canvasPixel(page, center.x, center.y)).toEqual(original);
  expect(errors).toEqual([]);
});

test('menu bar: all top-level menus, only working items, keyboard navigation', async ({ page }) => {
  const bar = page.getByRole('menubar', { name: 'Application menu' });
  await expect(bar.getByRole('menuitem')).toHaveText([
    'File',
    'Edit',
    'Image',
    'Layer',
    'Type',
    'Select',
    'Filter',
    'View',
    'Plugins',
    'Window',
    'Help',
  ]);
  for (const empty of ['Type', 'Select', 'Filter', 'Plugins'])
    await expect(bar.getByRole('menuitem', { name: empty })).toHaveAttribute('aria-disabled', 'true');
  await expect(bar.getByRole('menuitem', { name: 'Layer' })).toHaveAttribute('aria-disabled', 'false');

  await bar.getByRole('menuitem', { name: 'File' }).click();
  const file = page.getByRole('menu', { name: 'File' });
  await expect(file.getByRole('menuitem')).toHaveText([
    /^Open…/,
    /^Close/,
    /^Close All/,
    /^Close Others/,
    /^Save/,
    /^Save As…/,
  ]);
  await expect(file.getByRole('menuitem', { name: /^Close/ }).first()).toHaveAttribute('aria-disabled', 'true'); // nothing open
  await page.keyboard.press('Escape');
  await expect(file).toBeHidden();

  await openFile(page, 'rgb8.png');
  await page.keyboard.press('ControlOrMeta+I');
  await bar.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(page.getByRole('menu', { name: 'Edit' }).getByRole('menuitem').first()).toHaveText(/Undo Invert/);
  // Move to the Image menu with the arrow keys and run Invert from it.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('option', { name: 'Invert' })).toHaveCount(2);

  // View > Show > Pixel Grid is a checkable item.
  await bar.getByRole('menuitem', { name: 'View' }).click();
  await page.getByRole('menuitem', { name: 'Show' }).hover();
  const grid = page.getByRole('menuitemcheckbox', { name: 'Pixel Grid' });
  await expect(grid).toHaveAttribute('aria-checked', 'true');
  await grid.click();
  await bar.getByRole('menuitem', { name: 'View' }).click();
  await page.getByRole('menuitem', { name: 'Show' }).hover();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Pixel Grid' })).toHaveAttribute('aria-checked', 'false');
});

test('documents open in tabs, keep their own view, and ask before closing with unsaved changes', async ({ page }) => {
  await openFile(page, 'rgb8.png');
  await page.keyboard.press('ControlOrMeta+=');
  await openFile(page, 'photo.jpg');
  expect((await app(page)).docs).toBe(2);
  expect((await app(page)).zoom).toBe(1);
  await page.getByRole('tab', { name: /rgb8\.png/ }).click();
  expect((await app(page)).zoom).toBe(2); // view restored

  await page.keyboard.press('ControlOrMeta+I');
  await page.getByRole('button', { name: 'Close rgb8.png' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Save changes to “rgb8.png” before closing?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect((await app(page)).docs).toBe(2);
  await page.getByRole('button', { name: 'Close rgb8.png' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Don’t Save' }).click();
  expect((await app(page)).docs).toBe(1);
  await expect(page.getByRole('tab', { name: /photo\.jpg/ })).toHaveAttribute('aria-selected', 'true');
});

test('Save As writes a PNG and clears the unsaved marker', async ({ page }) => {
  await openFile(page, 'rgba8.png');
  await page.keyboard.press('ControlOrMeta+I');
  await expect(page.getByRole('tab', { name: /\*\)/ })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.keyboard.press('ControlOrMeta+Shift+S');
  expect((await download).suggestedFilename()).toBe('rgba8.png');
  await expect(page.getByRole('tab', { name: /^rgba8\.png @ .*\(RGB\/8\)$/ })).toBeVisible();
});

test('panels dock, group, float, collapse to icons and toggle from the Window menu', async ({ page }) => {
  const historyTab = page.getByRole('tab', { name: 'History' });
  const navigatorTab = page.getByRole('tab', { name: 'Navigator' });
  // Drag History into the Navigator group.
  const target = (await navigatorTab.boundingBox())!;
  await historyTab.hover();
  await page.mouse.down();
  await page.mouse.move(target.x + target.width + 20, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('[data-dock-tabstrip]')).toHaveCount(1);
  await expect(page.locator('[data-dock-tabstrip]').getByRole('tab')).toHaveText(['Navigator', 'History']);

  // Drag History out to float it.
  await page.getByRole('tab', { name: 'History' }).hover();
  await page.mouse.down();
  await page.mouse.move(400, 300, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('[data-floating]')).toHaveCount(1);

  // Window > History closes and reopens it.
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'History' }).click();
  await expect(page.getByRole('tab', { name: 'History' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'History' }).click();
  await expect(page.getByRole('tab', { name: 'History' })).toHaveCount(1);

  // Collapse the dock column to icons and show a panel from its icon.
  await page.getByRole('button', { name: 'Collapse to icons' }).click();
  await page.getByRole('button', { name: 'Navigator' }).click();
  await expect(page.getByRole('dialog', { name: 'Navigator' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand panels' }).click();

  // Window > Workspace > Reset Essentials restores the default layout.
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: 'Workspace' }).hover();
  await page.getByRole('menuitem', { name: 'Reset Essentials' }).click();
  await expect(page.locator('[data-dock-tabstrip]')).toHaveCount(2);
  await expect(page.locator('[data-floating]')).toHaveCount(0);
});

test('status bar zoom field accepts typed values and math', async ({ page }) => {
  await openFile(page, 'rgb8.png');
  const zoom = page.getByLabel('Zoom level');
  await zoom.fill('250');
  await zoom.press('Enter');
  expect((await app(page)).zoom).toBeCloseTo(2.5);
  await zoom.fill('*2');
  await zoom.press('Enter');
  expect((await app(page)).zoom).toBeCloseTo(5);
  await page.getByRole('button', { name: /^Doc:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Document Dimensions' }).click();
  await expect(page.getByRole('button', { name: '64 px × 48 px (300 ppi)' })).toBeVisible();
});

test('tool keys switch tools; holding a tool key borrows it', async ({ page }) => {
  await openFile(page, 'rgb8.png');
  await page.keyboard.press('z');
  await expect(page.getByRole('button', { name: 'Zoom Tool' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('checkbox', { name: 'Scrubby Zoom' })).toBeChecked();
  // Hold H, drag with the Hand tool, release: back to Zoom.
  const box = (await page.getByLabel('Document canvas').boundingBox())!;
  await page.keyboard.down('h');
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 320, box.y + 310, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('h');
  await expect(page.getByRole('button', { name: 'Zoom Tool' })).toHaveAttribute('aria-pressed', 'true');
  // Typing in a text field does not switch tools.
  await page.getByLabel('Zoom level').focus();
  await page.keyboard.press('h');
  await expect(page.getByRole('button', { name: 'Zoom Tool' })).toHaveAttribute('aria-pressed', 'true');
});

test("blend-mode shortcuts change the selected layer's mode", async ({ page }) => {
  await openFile(page, 'rgb8.png');
  await page.keyboard.press('ControlOrMeta+Alt+Shift+N'); // New Layer (no dialog)
  const mode = () =>
    page.evaluate(() => {
      const d = (window as unknown as AppWindow).__pixelforge.workspace.active!.doc;
      return d.getLayer(d.activeLayerId!)!.blendMode;
    });
  await page.keyboard.press('Alt+Shift+M');
  expect(await mode()).toBe('multiply');
  await page.keyboard.press('Shift+Equal');
  expect(await mode()).toBe('color-burn');
  await page.keyboard.press('Shift+Minus');
  await page.keyboard.press('Shift+Minus');
  expect(await mode()).toBe('darken');
  await page.keyboard.press('Alt+Shift+K'); // already Darken: no new history step
  const history = page.getByRole('listbox', { name: 'History states' });
  await expect(history.getByRole('option')).toHaveText([
    'Open',
    'New Layer',
    ...Array<string>(4).fill('Blend Mode Change'),
  ]);
  // In a text field the same chord types instead.
  await page.getByLabel('Zoom level').focus();
  await page.keyboard.press('Alt+Shift+S');
  expect(await mode()).toBe('darken');
});

test('dropping an image on the canvas opens it; non-images report an error', async ({ page }) => {
  const drop = (name: string, bytes: number[]) =>
    page.evaluate(
      ([fileName, data]) => {
        const area = document.querySelector('[data-testid=canvas-area]')!;
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(data as number[])], fileName as string));
        for (const type of ['dragenter', 'dragover', 'drop'])
          area.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
      },
      [name, bytes],
    );
  const png = [...(await import('node:fs')).readFileSync(join(FIXTURES, 'gray8.png'))];
  await drop('gray8.png', png);
  await expect(page.getByRole('tab', { name: /gray8\.png .*\(Gray\/8\)/ })).toBeVisible();
  await drop('notes.txt', [104, 105]);
  await expect(page.getByRole('dialog')).toContainText('Could not open “notes.txt”');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('Help > About shows the product name and version', async ({ page }) => {
  await page.getByRole('menuitem', { name: 'Help' }).click();
  await page.getByRole('menuitem', { name: `About ${APP_NAME}…` }).click();
  await expect(page.getByRole('dialog', { name: `About ${APP_NAME}` })).toContainText(`${APP_NAME} 0.0.0`);
  await page.getByRole('button', { name: 'OK' }).click();
});
