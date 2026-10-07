import { readFile } from 'node:fs/promises';
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
  // Native file dialogs cannot be driven by tests: use the file-input and download fallbacks.
  await page.addInitScript(() => {
    Object.assign(window, { showOpenFilePicker: undefined, showSaveFilePicker: undefined });
  });
  await page.goto('/');
  await page.getByTestId('app-root').waitFor();
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

async function open(page: Page, file: { name: string; buffer: Buffer } | string) {
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+O');
  const files =
    typeof file === 'string'
      ? join(FIXTURES, file)
      : { name: file.name, mimeType: 'application/octet-stream', buffer: file.buffer };
  await (await chooser).setFiles(files);
}

/** The active document's layers (bottom → top) with their main properties. */
const layers = (page: Page) =>
  page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    const doc = ws.active!.doc;
    const describe = (l: (typeof doc.root.children)[number]): unknown =>
      l.kind === 'group'
        ? { group: l.name, blendMode: l.blendMode, children: l.children.map(describe) }
        : {
            name: l.name,
            background: l.isBackground,
            visible: l.visible,
            opacity: Math.round(l.opacity * 100),
            blendMode: l.blendMode,
          };
    return { size: [doc.width, doc.height], layers: doc.root.children.map(describe) };
  });

const pixel = (page: Page, layerName: string, x: number, y: number) =>
  page.evaluate(
    ([name, px, py]) => {
      const doc = (window as unknown as AppWindow).__pixelforge.workspace.active!.doc;
      const find = (nodes: typeof doc.root.children): (typeof doc.root.children)[number] | undefined => {
        for (const n of nodes) {
          if (n.name === name) return n;
          if (n.kind === 'group') {
            const inner = find(n.children);
            if (inner) return inner;
          }
        }
        return undefined;
      };
      const l = find(doc.root.children) as {
        offsetX: number;
        offsetY: number;
        buffer: { getPixel(x: number, y: number): number[] };
      };
      return l.buffer.getPixel(px - l.offsetX, py - l.offsetY);
    },
    [layerName, x, y] as const,
  );

test('a layered image saves as PSD by default and opens again with its layers', async ({ page }) => {
  await open(page, 'photo.jpg'); // 96 × 64
  await expect(page.getByRole('tab', { name: /photo\.jpg/ })).toBeVisible();
  // A layer moved off the corner, half transparent, in Multiply, inside a group.
  await page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.execute({ name: 'newLayer', params: { name: 'Square' } });
    await ws.execute({
      name: 'selectShape',
      params: { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 10, y: 20, w: 30, h: 15 } },
    });
    await ws.execute({ name: 'fill', params: { color: [0, 200, 100] } });
    await ws.execute({ name: 'deselect', params: {} });
    const doc = ws.active!.doc;
    await ws.execute({
      name: 'setLayerProps',
      params: { layerId: doc.activeLayerId!, props: { opacity: 0.5, blendMode: 'multiply' } },
    });
    await ws.execute({ name: 'groupLayers', params: {} });
  });
  const before = await layers(page);
  const photoPixel = await pixel(page, 'Background', 50, 30);

  await page.keyboard.press('ControlOrMeta+Shift+S');
  const dialog = page.getByRole('dialog', { name: 'Save As' });
  await expect(dialog.getByLabel('Format')).toHaveValue('psd');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('photo.psd');
  const bytes = await readFile(await file.path());
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('8BPS');

  await open(page, { name: 'photo.psd', buffer: bytes });
  // The saved document's tab is named photo.psd now too: wait for the second one (active).
  await expect(page.getByRole('tab', { name: /photo\.psd/ })).toHaveCount(2);
  expect(await layers(page)).toEqual(before);
  expect(await pixel(page, 'Background', 50, 30)).toEqual(photoPixel);
  expect(await pixel(page, 'Square', 20, 25)).toEqual([0, 200, 100, 255]);
  expect((await pixel(page, 'Square', 5, 5))[3]).toBe(0);
});

test('PSD saving is offered only for 8-bit RGB documents', async ({ page }) => {
  await open(page, 'rgb16.png');
  await expect(page.getByRole('tab', { name: /rgb16\.png/ })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+S');
  const dialog = page.getByRole('dialog', { name: 'Save As' });
  await expect(dialog.getByLabel('Format')).toHaveValue('png');
  await expect(dialog.locator('option[value="psd"]')).toHaveAttribute('disabled', '');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});
