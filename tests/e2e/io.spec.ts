import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/e2e/harness/io.html');
  await page.waitForFunction(() => window.__io !== undefined);
});

test('opens an opaque PNG as a Background layer with its resolution, in shared tiles', async ({ page }) => {
  const doc = await page.evaluate(() => window.__io!.open('rgb8.png'));
  expect(doc).toMatchObject({
    width: 64,
    height: 48,
    mode: 'rgb',
    depth: 8,
    layerName: 'Background',
    isBackground: true,
    tileCount: 1,
    shared: true,
  });
  expect(doc.resolution).toBeCloseTo(300, 0);
  expect(doc.pixels[0]).toEqual([0, 0, 38]);
});

test('opens a transparent PNG as "Layer 0" and skips fully transparent tiles', async ({ page }) => {
  const doc = await page.evaluate(() =>
    window.__io!.open('tiles-rgba8.png', [
      [0, 0],
      [550, 10],
      [550, 280],
    ]),
  );
  expect(doc).toMatchObject({ width: 600, height: 300, layerName: 'Layer 0', isBackground: false, resolution: 72 });
  expect(doc.tileCount).toBe(5); // 3×2 grid minus the empty top-right tile
  expect(doc.pixels).toEqual([
    [0, 0, 0, 255],
    [0, 0, 0, 0],
    [550 % 256, 280 % 256, (550 + 280) % 256, 255],
  ]);
});

test('opens grayscale, 16-bit, palette, JPEG (with EXIF rotation) and WebP files', async ({ page }) => {
  const open = (name: string) => page.evaluate((n) => window.__io!.open(n), name);
  expect(await open('gray8.png')).toMatchObject({ mode: 'grayscale', depth: 8, isBackground: true });
  expect(await open('graya16.png')).toMatchObject({ mode: 'grayscale', depth: 16, isBackground: false });
  expect(await open('rgb16.png')).toMatchObject({ mode: 'rgb', depth: 16 });
  expect(await open('palette.png')).toMatchObject({ mode: 'rgb', isBackground: false }); // palette expanded (Indexed mode comes later)
  expect(await open('photo.jpg')).toMatchObject({ width: 96, height: 64, isBackground: true });
  expect(await open('photo-orient6.jpg')).toMatchObject({ width: 64, height: 96 });
  expect(await open('alpha.webp')).toMatchObject({ width: 96, height: 64, layerName: 'Layer 0' });
});

test('rejects files that are not images', async ({ page }) => {
  expect(await page.evaluate(() => window.__io!.openGarbage())).toContain('is not a PSD, PNG, JPEG or WebP file');
});

test('Save As PNG round-trips pixels, bit depth, transparency and resolution', async ({ page }) => {
  // Probes avoid fully transparent pixels, whose (invisible) colour is not kept when flattening.
  for (const name of ['rgb8.png', 'rgba8.png', 'rgb16.png', 'gray8.png', 'graya16.png']) {
    const r = await page.evaluate(
      (n) =>
        window.__io!.saveAndReopen(n, [
          [20, 10],
          [40, 30],
          [63, 47],
        ]),
      name,
    );
    expect(r.reopened, name).toMatchObject({
      width: r.original.width,
      height: r.original.height,
      mode: r.original.mode,
      depth: r.original.depth,
      isBackground: r.original.isBackground,
      pixels: r.original.pixels,
    });
    expect(r.reopened.resolution, name).toBeCloseTo(r.original.resolution, 0);
  }
});

test('Invert then Save As PNG writes the inverted pixels', async ({ page }) => {
  const r = await page.evaluate(() => window.__io!.invertThenSave());
  expect(r.after).toEqual(r.before.map((v) => 255 - v));
});

test('Save As PNG is refused for 32-bit documents with an explanation', async ({ page }) => {
  expect(await page.evaluate(() => window.__io!.saveRestriction())).toContain('32-bit');
});

test('dropping a file reports it and toggles the drop highlight', async ({ page }) => {
  expect(await page.evaluate(() => window.__io!.drop('rgb8.png'))).toEqual({
    received: ['rgb8.png'],
    states: [true, false],
  });
});

test('falls back to a file input and a download without native file dialogs', async ({ page }) => {
  const chooser = page.waitForEvent('filechooser');
  const picked = page.evaluate(() => window.__io!.pickWithFallback());
  await (await chooser).setFiles(join(import.meta.dirname, '../fixtures/images/rgb8.png'));
  expect(await picked).toEqual([{ name: 'rgb8.png', size: expect.any(Number) as unknown as number }]);

  const downloadEvent = page.waitForEvent('download');
  expect(await page.evaluate(() => window.__io!.saveWithFallback())).toEqual({
    kind: 'downloaded',
    name: 'picture.png',
  });
  expect((await downloadEvent).suggestedFilename()).toBe('picture.png');
});
