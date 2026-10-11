/**
 * Phase 2 exit test (PLAN Part E item 17): a small painting made the way a painter
 * works, with the tools and panels — File > New, a gradient sky, wet Mixer Brush
 * clouds, the History Brush bringing part of the clean sky back, pen strokes whose
 * size follows the pressure with colour jitter, a flower painted with radial
 * symmetry, a pattern defined from the picture and painted with the Pattern Stamp
 * on a Multiply layer. Then:
 *  - saved as PSD and opened again: the same layers, the same pixels on every layer
 *    and the same image (and the same layers again after a second save);
 *  - replayed from its recorded History steps on a fresh document, as an action
 *    would: the same image, pixel for pixel.
 *
 * With PF_PHASE2_CHECK_DIR set, the PSD and a PNG of how it should look are also
 * written there, for the owner's check with the reference app.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { AppController } from '../../src/app/controller';
import type { CommandDescriptor } from '../../src/core/commands/command';

type AppWindow = { __pixelforge: AppController; __recorded?: CommandDescriptor[] };

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
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

const canvas = (page: Page) => page.getByLabel('Document canvas');
const menubar = (page: Page) => page.getByRole('menubar', { name: 'Application menu' });
/** The History states, once painting has finished. */
const historyLabels = (page: Page) =>
  page.evaluate(async () => {
    const ws = (window as unknown as AppWindow).__pixelforge.workspace;
    await ws.whenIdle();
    return ws.active!.history.entries.map((e) => e.label);
  });

async function menu(page: Page, top: string, item: string) {
  await menubar(page).getByRole('menuitem', { name: top }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** File > New with a size in pixels. */
async function newDocument(page: Page, name: string, width: number, height: number) {
  await menu(page, 'File', 'New…');
  const dialog = page.getByRole('dialog', { name: 'New Document' });
  await dialog.getByRole('combobox', { name: 'Size unit' }).selectOption('pixels');
  for (const [field, value] of [
    ['Width', width],
    ['Height', height],
    ['Resolution', 72],
  ] as const) {
    await dialog.getByRole('textbox', { name: field }).fill(String(value));
    await dialog.getByRole('textbox', { name: field }).press('Tab');
  }
  await dialog.getByRole('textbox', { name: 'Document name' }).fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('tab', { name: new RegExp(name) })).toBeVisible();
  await page.evaluate(
    ([w, h]) => {
      const c = (window as unknown as AppWindow).__pixelforge;
      const ctx = c.canvas!.context;
      ctx.viewport.zoomTo(3 * c.canvas!.renderer.devicePixelRatio); // 3 CSS px per image px
      ctx.viewport.centerX = w! / 2;
      ctx.viewport.centerY = h! / 2;
      ctx.viewChanged();
    },
    [width, height],
  );
}

/** Page position of a document point. */
async function at(page: Page, x: number, y: number) {
  const box = (await canvas(page).boundingBox())!;
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

/** A mouse stroke through document points. */
async function drag(page: Page, points: [number, number][], steps = 8) {
  const first = await at(page, ...points[0]!);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const p of points.slice(1)) {
    const to = await at(page, ...p);
    await page.mouse.move(to.x, to.y, { steps });
  }
  await page.mouse.up();
}

/** A pen stroke through document points [x, y, pressure], with pointer moves in between. */
async function pen(page: Page, points: [number, number, number][]) {
  const samples: { x: number; y: number; pressure: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    const [x, y, pressure] = points[i]!;
    const next = points[i + 1];
    const steps = next ? 6 : 1;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const px = next ? x + (next[0] - x) * t : x;
      const py = next ? y + (next[1] - y) * t : y;
      const pp = next ? pressure + (next[2] - pressure) * t : pressure;
      samples.push({ ...(await at(page, px, py)), pressure: pp });
    }
  }
  await page.evaluate((pts) => {
    const target = document.querySelector('[aria-label="Document canvas"]')!;
    pts.forEach((p, i) => {
      const type = i === 0 ? 'pointerdown' : i === pts.length - 1 ? 'pointerup' : 'pointermove';
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 7,
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
  }, samples);
}

/** Chooses a tool by its letter, cycling the group with Shift+letter until it is `name`. */
async function tool(page: Page, key: string, name: string) {
  await canvas(page).focus();
  const picker = page.getByRole('button', { name: 'Tool preset picker' });
  const title = new RegExp(`^${name} —`);
  await page.keyboard.press(key);
  for (let i = 0; i < 4 && !title.test((await picker.getAttribute('title')) ?? ''); i++)
    await page.keyboard.press(`Shift+${key.toUpperCase()}`);
  await expect(picker).toHaveAttribute('title', title);
}

async function colors(page: Page, fg: [number, number, number], bg?: [number, number, number]) {
  await page.evaluate(
    ([f, b]) => {
      const c = (window as unknown as AppWindow).__pixelforge.colors;
      c.setForeground({ r: f[0], g: f[1], b: f[2] });
      if (b) c.setBackground({ r: b[0], g: b[1], b: b[2] });
    },
    [fg, bg] as const,
  );
}

/** Layer > New Layer with a name (Alt-click on the Layers panel's button opens the dialog). */
async function newLayer(page: Page, name: string, mode?: string, opacity?: number) {
  await page.getByRole('button', { name: 'New layer' }).click({ modifiers: ['Alt'] });
  const dialog = page.getByRole('dialog', { name: 'New Layer' });
  await dialog.getByLabel('Name').fill(name);
  if (mode) await dialog.getByLabel('Mode').selectOption(mode);
  if (opacity !== undefined) await dialog.getByRole('textbox', { name: 'Opacity' }).fill(String(opacity));
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByRole('listbox', { name: 'History states' }).getByRole('option').last()).toHaveText(
    'New Layer',
  );
}

/** The layer tree, every pixel layer's pixels over the canvas, and the composited image. */
const snapshot = (page: Page) =>
  page.evaluate(async () => {
    const c = (window as unknown as AppWindow).__pixelforge;
    await c.workspace.whenIdle();
    const doc = c.workspace.active!.doc;
    type Node = (typeof doc.root.children)[number];
    const pixels: Record<string, number[]> = {};
    const describe = (l: Node): unknown => {
      if (l.kind === 'pixel') {
        const out: number[] = [];
        for (let y = 0; y < doc.height; y++)
          for (let x = 0; x < doc.width; x++) {
            const p = l.buffer.getPixel(x - l.offsetX, y - l.offsetY);
            // Colour under full transparency is not kept by the file format.
            out.push(...(p.length === 4 && p[3] === 0 ? [0, 0, 0, 0] : p));
          }
        pixels[l.name] = out;
      }
      return {
        name: l.name,
        kind: l.kind,
        visible: l.visible,
        opacity: Math.round(l.opacity * 100),
        fill: Math.round(l.fillOpacity * 100),
        blendMode: l.blendMode,
        ...(l.kind === 'group' ? { children: l.children.map(describe) } : { background: l.isBackground }),
      };
    };
    const layers = doc.root.children.map(describe);
    const composite = c.canvas!.renderer.readComposite(doc.canvasRect);
    return {
      size: [doc.width, doc.height, doc.resolution],
      layers,
      pixels,
      composite: Array.from(composite, (v) => Math.round(v * 255)),
    };
  });

/** Painted (not fully transparent) pixels of a layer's snapshot. */
const painted = (rgba: number[]) => rgba.filter((v, i) => i % 4 === 3 && v > 0).length;

async function saveAs(page: Page, format: string): Promise<Buffer> {
  await page.keyboard.press('ControlOrMeta+Shift+S');
  const dialog = page.getByRole('dialog', { name: 'Save As' });
  await dialog.getByLabel('Format').selectOption(format);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save' }).click();
  return readFile(await (await download).path());
}

async function open(page: Page, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+O');
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer });
  await expect(page.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) })).toBeVisible();
}

test('Phase 2 exit: a painting session round-trips through PSD and replays identically', async ({ page }) => {
  test.setTimeout(120_000);
  await newDocument(page, 'Meadow', 240, 160);

  // A sky: a gradient from blue to a pale horizon.
  await colors(page, [0.35, 0.6, 0.95], [1, 0.95, 0.8]);
  await tool(page, 'g', 'Gradient Tool');
  await drag(page, [
    [120, 0],
    [120, 120],
  ]);

  // Clouds: a wet Mixer Brush loaded with white drags the sky along.
  await colors(page, [1, 1, 1]);
  await tool(page, 'b', 'Mixer Brush Tool');
  await page.getByRole('combobox', { name: 'Useful mixer brush combinations' }).selectOption('wet');
  await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.tools.mixerBrush.setOptions({ size: 24 }));
  await canvas(page).focus();
  await drag(page, [
    [30, 30],
    [110, 40],
  ]);
  await drag(page, [
    [130, 25],
    [210, 35],
  ]);

  // The History Brush paints the clean sky (the Gradient state) back over part of a cloud.
  await tool(page, 'y', 'History Brush Tool');
  await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.tools.historyBrush.setOptions({ size: 16 }));
  await page.getByRole('radio', { name: 'History Brush source: Gradient' }).click();
  await expect(page.getByRole('radio', { name: 'History Brush source: Gradient' })).toBeChecked();
  const sourceSwitch = { at: (await historyLabels(page)).length, index: 1 };
  await canvas(page).focus();
  await drag(page, [
    [160, 20],
    [205, 42],
  ]);

  // Hills: pen strokes, thin where pressed lightly, with shape and colour dynamics.
  await newLayer(page, 'Hills');
  await tool(page, 'b', 'Brush Tool');
  await page.evaluate(() =>
    (window as unknown as AppWindow).__pixelforge.tools.brush.setOptions({ size: 16, hardness: 0.6 }),
  );
  await page.keyboard.press('F5');
  const settings = page.locator('.brush-settings');
  await settings.getByRole('checkbox', { name: 'Use Shape Dynamics' }).check();
  await settings.getByRole('tab', { name: 'Shape Dynamics' }).click();
  await settings.getByRole('combobox', { name: 'Size Jitter control' }).selectOption('pressure');
  await settings.getByRole('checkbox', { name: 'Use Color Dynamics' }).check();
  await settings.getByRole('tab', { name: 'Color Dynamics' }).click();
  for (const [field, value] of [
    ['Hue Jitter', '6'],
    ['Brightness Jitter', '12'],
  ]) {
    await settings.getByRole('textbox', { name: field!, exact: true }).fill(value!);
    await settings.getByRole('textbox', { name: field!, exact: true }).press('Enter');
  }
  await canvas(page).focus();
  await page.keyboard.press('F5');
  await expect(settings).toHaveCount(0);
  await colors(page, [0.25, 0.55, 0.2], [0.1, 0.35, 0.15]);
  for (const [y, rise] of [
    [118, 14],
    [134, 10],
    [148, 8],
  ] as const) {
    const points: [number, number, number][] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      points.push([4 + 232 * t, y - rise * Math.sin(Math.PI * t * 1.5), 0.15 + 0.85 * Math.sin(Math.PI * t)]);
    }
    await pen(page, points);
  }

  // A flower: radial symmetry with 8 segments around the canvas centre, then turned off.
  await newLayer(page, 'Flower');
  await canvas(page).focus();
  await page.getByRole('button', { name: 'Paint symmetry' }).click();
  await page.getByRole('menu', { name: 'Paint symmetry' }).getByRole('menuitemcheckbox', { name: 'Radial…' }).click();
  const radial = page.getByRole('dialog', { name: 'Radial Symmetry' });
  await radial.getByRole('textbox', { name: 'Segment Count:' }).fill('8');
  await radial.getByRole('button', { name: 'OK' }).click();
  await canvas(page).focus();
  await page.keyboard.press('Enter'); // apply the guide where it is (the canvas centre)
  await expect(page.getByRole('button', { name: 'Apply symmetry placement' })).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as AppWindow).__pixelforge.tools.brush.setOptions({ size: 7, hardness: 0.9 }),
  );
  await colors(page, [0.85, 0.2, 0.6]);
  await drag(page, [
    [120, 76],
    [118, 64],
    [120, 54],
  ]);
  await colors(page, [1, 0.85, 0.1]);
  await drag(page, [
    [120, 79],
    [121, 81],
  ]);
  await page.getByRole('button', { name: 'Paint symmetry' }).click();
  await page
    .getByRole('menu', { name: 'Paint symmetry' })
    .getByRole('menuitemcheckbox', { name: 'Turn Off Symmetry' })
    .click();
  expect(
    await page.evaluate(() => (window as unknown as AppWindow).__pixelforge.workspace.active!.doc.symmetry?.enabled),
  ).toBe(false);

  // A pattern from the flower (Edit > Define Pattern on a rectangular selection)…
  await tool(page, 'm', 'Rectangular Marquee Tool');
  await drag(
    page,
    [
      [96, 56],
      [144, 104],
    ],
    4,
  );
  await menu(page, 'Edit', 'Define Pattern…');
  const patternName = page.getByRole('dialog', { name: 'Pattern Name' });
  await patternName.getByRole('textbox').fill('Flower tile');
  await patternName.getByRole('button', { name: 'OK' }).click();
  await canvas(page).focus();
  await page.keyboard.press('ControlOrMeta+D');

  // …painted with the Pattern Stamp on a Multiply layer at 50 %.
  await newLayer(page, 'Texture', 'multiply', 50);
  await tool(page, 's', 'Pattern Stamp Tool');
  const stamp = await page.evaluate(() => {
    const c = (window as unknown as AppWindow).__pixelforge;
    c.tools.patternStamp.setOptions({ size: 22, hardness: 0.8 });
    return c.services.patterns.get(c.tools.patternStamp.stamp.patternId)?.name;
  });
  expect(stamp).toBe('Flower tile');
  await canvas(page).focus();
  await drag(page, [
    [10, 150],
    [120, 145],
    [230, 152],
  ]);

  const labels = await historyLabels(page);
  expect(labels).toEqual([
    'New',
    'Gradient',
    'Mixer Brush',
    'Mixer Brush',
    'History Brush',
    'New Layer',
    'Brush Tool',
    'Brush Tool',
    'Brush Tool',
    'New Layer',
    'New Symmetry',
    'Brush Tool',
    'Brush Tool',
    'Turn Off Symmetry',
    'Rectangular Marquee',
    'Deselect',
    'New Layer',
    'Pattern Stamp',
  ]);
  const before = await snapshot(page);
  expect(before.size).toEqual([240, 160, 72]);
  expect(before.layers).toEqual([
    {
      name: 'Background',
      kind: 'pixel',
      visible: true,
      opacity: 100,
      fill: 100,
      blendMode: 'normal',
      background: true,
    },
    { name: 'Hills', kind: 'pixel', visible: true, opacity: 100, fill: 100, blendMode: 'normal', background: false },
    { name: 'Flower', kind: 'pixel', visible: true, opacity: 100, fill: 100, blendMode: 'normal', background: false },
    { name: 'Texture', kind: 'pixel', visible: true, opacity: 50, fill: 100, blendMode: 'multiply', background: false },
  ]);
  // Every layer has its painting.
  expect(painted(before.pixels['Hills']!)).toBeGreaterThan(2000);
  expect(painted(before.pixels['Flower']!)).toBeGreaterThan(300);
  expect(painted(before.pixels['Texture']!)).toBeGreaterThan(2000);

  // Saved as PSD and opened again: the same layers, pixels and image.
  const psd = await saveAs(page, 'psd');
  expect(psd.subarray(0, 4).toString('latin1')).toBe('8BPS');
  await open(page, 'painting.psd', psd);
  const after = await snapshot(page);
  expect(after.size).toEqual(before.size);
  expect(after.layers).toEqual(before.layers);
  for (const name of Object.keys(before.pixels))
    expect(after.pixels[name]!.join() === before.pixels[name]!.join(), `layer ${name}`).toBe(true);
  let worst = 0;
  for (let i = 0; i < before.composite.length; i++)
    worst = Math.max(worst, Math.abs(before.composite[i]! - after.composite[i]!));
  expect(worst).toBeLessThanOrEqual(1);
  // Saving the reopened file gives the same layers again (a stable round trip).
  const again = await saveAs(page, 'psd');
  await open(page, 'again.psd', again);
  expect((await snapshot(page)).layers).toEqual(before.layers);

  // Replayed from the recorded steps on a new document of the same size: the same image.
  await page.getByRole('tab', { name: /^Meadow/ }).click();
  await page.evaluate(() => {
    const w = window as unknown as AppWindow;
    const h = w.__pixelforge.workspace.active!.history;
    w.__recorded = h.entries.slice(1).map((e) => h.descriptorOf(e.id)!);
  });
  await menu(page, 'File', 'New…');
  const dialog = page.getByRole('dialog', { name: 'New Document' });
  await expect(dialog.getByRole('textbox', { name: 'Width' })).toHaveValue('240'); // Recent: the last document
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('tab', { name: /Untitled-1/ })).toBeVisible();
  await page.evaluate(async (source) => {
    const w = window as unknown as AppWindow;
    const ws = w.__pixelforge.workspace;
    const session = ws.active!;
    for (const d of w.__recorded!) {
      if (session.history.entries.length === source.at) await session.history.setSource(source.index);
      await ws.execute(d);
    }
    await ws.whenIdle();
  }, sourceSwitch);
  expect(await historyLabels(page)).toEqual(labels);
  const replayed = await snapshot(page);
  expect(replayed.layers).toEqual(before.layers);
  for (const name of Object.keys(before.pixels))
    expect(replayed.pixels[name]!.join() === before.pixels[name]!.join(), `layer ${name}`).toBe(true);
  expect(replayed.composite.join() === before.composite.join()).toBe(true);

  const dir = process.env['PF_PHASE2_CHECK_DIR'];
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'painting.psd'), psd);
    await page.getByRole('tab', { name: /^painting\.psd/ }).click();
    await writeFile(join(dir, 'painting-expected.png'), await saveAs(page, 'png'));
  }
});
