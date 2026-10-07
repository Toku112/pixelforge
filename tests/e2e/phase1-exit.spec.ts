/**
 * Phase 1 exit test (PLAN Part D item 13): build a layered composition with the
 * Phase 1 features, save it as PSD, open the file again, and check that the layer
 * tree and the composited image are unchanged.
 *
 * With PF_PHASE1_CHECK_DIR set, the PSD and a PNG of how it should look are also
 * written there, for the owner's check with the reference app.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { AppController } from '../../src/app/controller';

type AppWindow = { __pixelforge: AppController };

const FIXTURES = join(import.meta.dirname, '../fixtures/images');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { showOpenFilePicker: undefined, showSaveFilePicker: undefined });
  });
  await page.goto('/');
  await page.getByTestId('app-root').waitFor();
});

async function open(page: Page, file: string | { name: string; buffer: Buffer }) {
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+O');
  await (
    await chooser
  ).setFiles(
    typeof file === 'string'
      ? join(FIXTURES, file)
      : { name: file.name, mimeType: 'application/octet-stream', buffer: file.buffer },
  );
}

/** The layer tree with every property PSD should keep, and the composited image. */
const snapshot = (page: Page) =>
  page.evaluate(async () => {
    const c = (window as unknown as AppWindow).__pixelforge;
    await c.workspace.whenIdle();
    const doc = c.workspace.active!.doc;
    type Node = (typeof doc.root.children)[number];
    const describe = (l: Node): unknown => ({
      name: l.name,
      kind: l.kind,
      visible: l.visible,
      opacity: Math.round(l.opacity * 100),
      fill: Math.round(l.fillOpacity * 100),
      blendMode: l.blendMode,
      locks: [l.locks.transparency, l.locks.pixels, l.locks.position],
      ...(l.kind === 'group' ? { children: l.children.map(describe) } : { background: l.isBackground }),
    });
    const composite = c.canvas!.renderer.readComposite(doc.canvasRect);
    return {
      size: [doc.width, doc.height, doc.resolution],
      layers: doc.root.children.map(describe),
      composite: Array.from(composite, (v) => Math.round(v * 255)),
    };
  });

async function saveAs(page: Page, format: string): Promise<Buffer> {
  await page.keyboard.press('ControlOrMeta+Shift+S');
  const dialog = page.getByRole('dialog', { name: 'Save As' });
  await dialog.getByLabel('Format').selectOption(format);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save' }).click();
  return readFile(await (await download).path());
}

test('Phase 1 exit: a layered composition round-trips through PSD unchanged', async ({ page }) => {
  await open(page, 'photo.jpg'); // 96 × 64
  await expect(page.getByRole('tab', { name: /photo\.jpg/ })).toBeVisible();
  await page.evaluate(async () => {
    const c = (window as unknown as AppWindow).__pixelforge;
    const ws = c.workspace;
    const run = (name: string, params: Record<string, unknown> = {}) => ws.execute({ name, params: params as never });
    const active = () => ws.active!.doc.activeLayerId!;
    const props = (p: Record<string, unknown>) => run('setLayerProps', { layerId: active(), props: p });

    // A larger canvas around the photo, in the extension colour.
    await run('canvasSize', { width: 160, height: 120, anchor: [0.5, 0.5], color: [235, 230, 220] });
    // A brush stroke on its own layer, moved a little.
    await run('newLayer', { name: 'Paint' });
    await run('paintStroke', {
      tool: 'brush',
      color: [200, 40, 40],
      brush: {
        size: 9,
        hardness: 0.8,
        opacity: 1,
        flow: 1,
        spacing: 0.25,
        pressureSize: false,
        pressureOpacity: false,
      },
      points: [20, 100, 1, 70, 80, 1, 140, 105, 1], // x, y, pressure
    });
    await run('translateLayers', { dx: 4, dy: -3 });
    // A Multiply square at 60 % opacity and 80 % fill, with its position locked.
    await run('newLayer', { name: 'Square' });
    await run('selectShape', { tool: 'rectangular-marquee', shape: { kind: 'rect', x: 50, y: 30, w: 50, h: 40 } });
    await run('fill', { color: [40, 120, 220] });
    await run('deselect');
    await props({ blendMode: 'multiply', opacity: 0.6, fillOpacity: 0.8 });
    await props({ locks: { transparency: false, pixels: false, position: true, artboardNesting: false, all: false } });
    // A soft-edged circle, rotated with Free Transform, inside a group at 70 % (Screen).
    await run('newLayer', { name: 'Circle' });
    await run('selectShape', {
      tool: 'elliptical-marquee',
      shape: { kind: 'ellipse', x: 100, y: 20, w: 44, h: 30 },
      feather: 2,
    });
    await run('fill', { color: [250, 200, 30] });
    await run('deselect');
    const r = Math.PI / 6;
    const [cx, cy] = [122, 35];
    await run('freeTransform', {
      matrix: [
        Math.cos(r),
        -Math.sin(r),
        cx - Math.cos(r) * cx + Math.sin(r) * cy,
        Math.sin(r),
        Math.cos(r),
        cy - Math.sin(r) * cx - Math.cos(r) * cy,
        0,
        0,
        1,
      ],
    });
    await run('groupLayers', { name: 'Shapes' });
    await props({ opacity: 0.7, blendMode: 'screen' });
    // A hidden layer (created inside the open group).
    await run('newLayer', { name: 'Hidden' });
    await run('selectAll');
    await run('fill', { color: [0, 0, 0] });
    await run('deselect');
    await props({ visible: false });
  });
  const before = await snapshot(page);
  // Background, Paint, Square, and the group Shapes holding Circle and Hidden (a new layer goes
  // into the selected, open group).
  expect(before.layers).toHaveLength(4);

  const psd = await saveAs(page, 'psd');
  expect(psd.subarray(0, 4).toString('latin1')).toBe('8BPS');
  await open(page, { name: 'composition.psd', buffer: psd });
  await expect(page.getByRole('tab', { name: /composition\.psd/ })).toBeVisible(); // the first is now photo.psd
  const after = await snapshot(page);
  expect(after.size).toEqual(before.size);
  expect(after.layers).toEqual(before.layers);
  // The same image (8-bit file: equal to the 8-bit value).
  let worst = 0;
  for (let i = 0; i < before.composite.length; i++)
    worst = Math.max(worst, Math.abs(before.composite[i]! - after.composite[i]!));
  expect(worst).toBeLessThanOrEqual(1);

  // Saving the reopened file gives the same layers again (a stable round trip).
  const again = await saveAs(page, 'psd');
  await open(page, { name: 'again.psd', buffer: again });
  await expect(page.getByRole('tab', { name: /again\.psd/ })).toBeVisible();
  expect((await snapshot(page)).layers).toEqual(before.layers);

  const dir = process.env['PF_PHASE1_CHECK_DIR'];
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'composition.psd'), psd);
    await page.getByRole('tab', { name: /^composition\.psd/ }).click();
    const png = await saveAs(page, 'png');
    await writeFile(join(dir, 'composition-expected.png'), png);
  }
});
