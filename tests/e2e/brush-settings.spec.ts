import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { AppController } from '../../src/app/controller';
import type { CommandDescriptor } from '../../src/core/commands/command';

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
    ctx.viewport.zoomTo(4);
    ctx.viewport.centerX = 48;
    ctx.viewport.centerY = 32;
    ctx.viewChanged();
  });
  // Paint on a transparent layer, with the Brush.
  await page.keyboard.press('ControlOrMeta+Alt+Shift+N');
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('b');
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

/** Canvas-page position of a document point. */
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

/** Every pixel of the active layer (RGBA, row by row), once work has finished. */
const layerPixels = (page: Page) =>
  page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    const doc = ws.active!.doc;
    const l = doc.activeLayer as { buffer: { getPixel(x: number, y: number): number[] } };
    const out: number[] = [];
    for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) out.push(...l.buffer.getPixel(x, y));
    return out;
  });

/** Painted height (opaque-ish rows) of the active layer's column x. */
const columnHeight = (pixels: number[], x: number) => {
  let n = 0;
  for (let y = 0; y < 64; y++) if (pixels[(y * 96 + x) * 4 + 3]! > 128) n++;
  return n;
};

const lastDescriptor = (page: Page) =>
  page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    const h = ws.active!.history;
    return h.descriptorOf(h.entries.at(-1)!.id);
  });

const panel = (page: Page) => page.locator('.brush-settings');

async function openSection(page: Page, name: string) {
  await panel(page)
    .getByRole('checkbox', { name: `Use ${name}` })
    .check();
  await panel(page).getByRole('tab', { name }).click();
}

async function setField(page: Page, name: string, value: string) {
  const field = panel(page).getByRole('textbox', { name, exact: true });
  await field.fill(value);
  await field.press('Enter');
}

/** A pen stroke along y = 32 from x = 10 to 86 with pressure rising from 0.05 to 1. */
async function taperedPenStroke(page: Page) {
  const points = [];
  for (let i = 0; i <= 12; i++)
    points.push({ ...(await at(page, 10 + (76 * i) / 12, 32)), pressure: 0.05 + 0.95 * (i / 12) });
  await page.evaluate((pts) => {
    const canvas = document.querySelector('[aria-label="Document canvas"]')!;
    pts.forEach((p, i) => {
      const type = i === 0 ? 'pointerdown' : i === pts.length - 1 ? 'pointerup' : 'pointermove';
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 9,
          pointerType: 'pen',
          isPrimary: true,
          bubbles: true,
          clientX: p.x,
          clientY: p.y,
          button: type === 'pointermove' ? -1 : 0,
          buttons: type === 'pointerup' ? 0 : 1,
          pressure: type === 'pointerup' ? 0 : p.pressure,
        }),
      );
    });
  }, points);
}

test('F5 opens Brush Settings in its own window; its sections edit the Brush and redraw the preview', async ({
  page,
}) => {
  await page.keyboard.press('F5');
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('.floating-panel').getByRole('tab', { name: 'Brush Settings' })).toBeVisible();
  await expect(panel(page).getByRole('tab', { name: 'Brush Tip Shape' })).toHaveAttribute('aria-selected', 'true');

  const preview = panel(page).getByRole('img', { name: 'Brush stroke preview' });
  const previewInk = () =>
    preview.evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3]! > 0 && d[i]! < 128) ink++;
      return ink;
    });
  await expect.poll(previewInk).toBeGreaterThan(1000);
  const full = await previewInk();

  // Pen pressure on the size: the preview stroke (pressure rising and falling) gets thinner.
  await openSection(page, 'Shape Dynamics');
  await panel(page).getByRole('combobox', { name: 'Size Jitter control' }).selectOption('pressure');
  await expect.poll(previewInk).toBeLessThan(full * 0.8);
  const dynamics = await page.evaluate(() => {
    const c = (window as unknown as AppWindow).__pixelforge;
    return (c.tools.byId.get('brush') as unknown as { options: { dynamics: { shape: unknown } } }).options.dynamics
      .shape;
  });
  expect(dynamics).toMatchObject({ enabled: true, size: { control: 'pressure' } });

  // The Eraser has no colour to vary.
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('e');
  await expect(panel(page).getByRole('checkbox', { name: 'Use Color Dynamics' })).toBeDisabled();
  // Other tools have no brush.
  await page.keyboard.press('v');
  await expect(page.locator('.floating-panel')).toContainText('Choose a painting tool');

  // F5 again closes it.
  await page.keyboard.press('F5');
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator('.floating-panel')).toHaveCount(0);
});

test('size by pen pressure: a stroke pressed harder and harder widens', async ({ page }) => {
  await page.keyboard.press('F5');
  await openSection(page, 'Shape Dynamics');
  await panel(page).getByRole('combobox', { name: 'Size Jitter control' }).selectOption('pressure');
  await page.getByLabel('Document canvas').focus();
  await taperedPenStroke(page);
  await expect(page.getByRole('listbox', { name: 'History states' }).getByRole('option').last()).toHaveText(
    'Brush Tool',
  );
  const pixels = await layerPixels(page);
  const thin = columnHeight(pixels, 16);
  // The last dab lands near x = 74 (Spacing leaves the final stretch), at about 84 % pressure.
  const wide = columnHeight(pixels, 74);
  expect(thin).toBeGreaterThan(0); // joined up at the light end
  expect(thin).toBeLessThanOrEqual(6);
  expect(wide).toBeGreaterThanOrEqual(22); // 84 % of 30 px
  // Every column along the stroke has paint: the thin end stays continuous.
  for (let x = 12; x <= 84; x++) expect(columnHeight(pixels, x), `column ${x}`).toBeGreaterThan(0);
});

test('scattering and colour dynamics are recorded with their seed and replay identically', async ({ page }) => {
  await page.evaluate(() =>
    (window as unknown as AppWindow).__pixelforge.colors.setForeground({ r: 0.9, g: 0.2, b: 0.1 }),
  );
  await page.keyboard.press('F5');
  await openSection(page, 'Scattering');
  await setField(page, 'Scatter', '200');
  await setField(page, 'Count', '3');
  await openSection(page, 'Color Dynamics');
  await setField(page, 'Hue Jitter', '50');
  await page.getByLabel('Document canvas').focus();
  const a = await at(page, 15, 32);
  const b = await at(page, 80, 32);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();

  const painted = await layerPixels(page);
  // Dabs land off the line (scatter 200 % of 30 px), and in more than one colour.
  expect(columnHeight(painted, 48)).toBeGreaterThan(0);
  const offLine = [5, 10, 54, 58].some(
    (y) => painted[(y * 96 + 48) * 4 + 3]! > 0 || painted[(y * 96 + 30) * 4 + 3]! > 0,
  );
  expect(offLine).toBe(true);
  const hues = new Set<string>();
  for (let i = 0; i < painted.length; i += 4)
    if (painted[i + 3] === 255) hues.add(`${painted[i]! >> 5},${painted[i + 1]! >> 5},${painted[i + 2]! >> 5}`);
  expect(hues.size).toBeGreaterThan(3);

  const d = (await lastDescriptor(page)) as CommandDescriptor & {
    params: { seed: number; colors?: unknown; brush: { dynamics: { scatter: { enabled: boolean; count: number } } } };
  };
  expect(d.params.brush.dynamics.scatter).toMatchObject({ enabled: true, count: 3 });
  expect(Number.isInteger(d.params.seed)).toBe(true);
  expect(d.params.colors).toBeDefined();

  // Undo, then run the recorded step again (as an action would): the same pixels.
  await page.keyboard.press('ControlOrMeta+Z');
  expect((await layerPixels(page)).some((v, i) => i % 4 === 3 && v > 0)).toBe(false);
  // (Passed as JSON: the descriptor type is too deep for the evaluate argument's types.)
  await page.evaluate(
    (json) => (window as unknown as AppWindow).__pixelforge.workspace.execute(JSON.parse(json) as CommandDescriptor),
    JSON.stringify(d),
  );
  expect(await layerPixels(page)).toEqual(painted);
});

/** Closes the floating Brush Settings window (F5), so it covers no part of the canvas. */
async function closePanel(page: Page) {
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('F5');
  await expect(panel(page)).toHaveCount(0);
}

/** A mouse stroke along y = 32 from x = 15 to 80 (with the Brush Settings window closed). */
async function mouseStroke(page: Page) {
  await closePanel(page);
  const a = await at(page, 15, 32);
  const b = await at(page, 80, 32);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}

/** Alpha values of the active layer along row y from x0 to x1. */
const alphaRow = (pixels: number[], y: number, x0: number, x1: number) =>
  Array.from({ length: x1 - x0 + 1 }, (_, i) => pixels[(y * 96 + x0 + i) * 4 + 3]!);

test('Texture: a chosen pattern shows through the stroke and is recorded with it', async ({ page }) => {
  await page.keyboard.press('F5');
  await openSection(page, 'Texture');
  await panel(page).getByRole('option', { name: 'Hatching' }).click();
  await expect(panel(page).getByRole('option', { name: 'Hatching' })).toHaveAttribute('aria-selected', 'true');
  // Minimum Depth and Depth Jitter need Texture Each Tip.
  await expect(panel(page).getByRole('textbox', { name: 'Depth Jitter' })).toBeDisabled();
  await mouseStroke(page);
  const row = alphaRow(await layerPixels(page), 32, 30, 65);
  // Hatching at full depth: bare lines across the paint.
  expect(Math.max(...row)).toBe(255);
  expect(Math.min(...row)).toBeLessThan(60);
  const d = (await lastDescriptor(page)) as unknown as {
    params: { brush: { dynamics: { texture: { enabled: boolean; pattern: string } } } };
  };
  expect(d.params.brush.dynamics.texture).toMatchObject({ enabled: true, pattern: 'pf-hatching' });
});

test('Dual Brush: a small scattered second tip bites into the stroke', async ({ page }) => {
  await page.keyboard.press('F5');
  await openSection(page, 'Dual Brush');
  await setField(page, 'Dual brush size', '6');
  await setField(page, 'Dual brush spacing', '300');
  await mouseStroke(page);
  const pixels = await layerPixels(page);
  const row = alphaRow(pixels, 32, 25, 70);
  expect(Math.max(...row)).toBe(255);
  expect(row.filter((a) => a === 0).length).toBeGreaterThan(5); // gaps between the 6 px dual dabs
  // Nothing outside the 30 px main stroke.
  expect(alphaRow(pixels, 10, 0, 95).every((a) => a === 0)).toBe(true);
});

test('Wet Edges and Build-up: a lighter middle with a darker rim; holding still builds paint up', async ({ page }) => {
  await page.keyboard.press('F5');
  await panel(page).getByRole('checkbox', { name: 'Wet Edges' }).check();
  await mouseStroke(page);
  const wet = await layerPixels(page);
  expect(wet[(32 * 96 + 48) * 4 + 3]).toBe(128); // the middle at half
  expect(Math.max(...Array.from({ length: 14 }, (_, k) => wet[((18 + k) * 96 + 48) * 4 + 3]!))).toBeGreaterThan(200);

  // Build-up with a low flow: a held press paints more than a quick click.
  await page.keyboard.press('F5');
  await panel(page).getByRole('checkbox', { name: 'Wet Edges' }).uncheck();
  await panel(page).getByRole('checkbox', { name: 'Build-up' }).check();
  await page.evaluate(() => {
    const brush = (window as unknown as AppWindow).__pixelforge.tools.byId.get('brush') as unknown as {
      setOptions(o: { flow: number }): void;
    };
    brush.setOptions({ flow: 0.1 });
  });
  await closePanel(page);
  await page.keyboard.press('ControlOrMeta+Alt+Shift+N');
  await page.getByLabel('Document canvas').focus();
  const quick = await at(page, 25.5, 20.5);
  await page.mouse.click(quick.x, quick.y);
  const held = await at(page, 70.5, 44.5);
  await page.mouse.move(held.x, held.y);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  const after = await layerPixels(page);
  const quickAlpha = after[(20 * 96 + 25) * 4 + 3]!;
  const heldAlpha = after[(44 * 96 + 70) * 4 + 3]!;
  expect(quickAlpha).toBeLessThan(40); // one dab at 10 % flow
  expect(heldAlpha).toBeGreaterThan(200); // about 20 dabs in 0.7 s
  // The held press is recorded with its samples over time, so it replays the same.
  const d = (await lastDescriptor(page)) as unknown as { params: { points: number[] } };
  expect(d.params.points.length / 8).toBeGreaterThan(10);
});
