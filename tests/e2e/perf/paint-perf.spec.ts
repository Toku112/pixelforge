import { expect, test } from '@playwright/test';
import type { AppController } from '../../../src/app/controller';
import type * as DocumentModule from '../../../src/core/document/document';

type AppWindow = { __pixelforge: AppController };

// Phase 2 target (PLAN Part E item 8): a 500 px soft brush paints at 60 fps on a
// 6000 × 4000 16-bit document. Runs on the real GPU (`pnpm test:perf`).
test('a 500 px soft brush keeps up at 60 fps on a 6000 × 4000 16-bit document', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByTestId('app-root').waitFor();
  await page.evaluate(async () => {
    const path = '/src/core/document/document.ts';
    const { ImageDocument } = (await import(/* @vite-ignore */ path)) as typeof DocumentModule;
    const c = (window as unknown as AppWindow).__pixelforge;
    const doc = new ImageDocument({ width: 6000, height: 4000, name: 'big', mode: 'rgb', depth: 16 });
    const layer = doc.createPixelLayer('Paint');
    doc.insertLayer(layer);
    doc.setActiveLayer(layer.id);
    c.workspace.add(doc);
  });
  await page.getByLabel('Document canvas').focus();
  await page.keyboard.press('b');
  const r = await page.evaluate(async () => {
    const c = (window as unknown as AppWindow).__pixelforge;
    const brush = c.tools.brush;
    brush.setOptions({ size: 500, hardness: 0, spacing: 0.1, flow: 1, opacity: 1 });
    brush.setSmoothing({ amount: 0, curves: false });
    const view = c.canvas!;
    // At 50 %: a fast stroke moving 30 CSS px (60 image px) every frame.
    view.context.viewport.zoomTo(0.5 * view.renderer.devicePixelRatio);
    view.context.viewport.centerX = 3000;
    view.context.viewport.centerY = 2000;
    view.context.viewChanged();
    const el = document.querySelector<HTMLElement>('[aria-label="Document canvas"]')!;
    const box = el.getBoundingClientRect();
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const send = (type: string, x: number, y: number) =>
      el.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          bubbles: true,
          clientX: x,
          clientY: y,
          button: type === 'pointermove' ? -1 : 0,
          buttons: type === 'pointerup' ? 0 : 1,
        }),
      );
    const moves = 150;
    const at = (i: number) => ({
      x: box.left + 100 + (i / moves) * (box.width - 200),
      y: box.top + box.height / 2 + Math.sin(i / 12) * box.height * 0.3,
    });
    await frame();
    let p = at(0);
    send('pointerdown', p.x, p.y);
    const intervals: number[] = [];
    let last = await frame();
    for (let i = 1; i <= moves; i++) {
      p = at(i);
      send('pointermove', p.x, p.y);
      const now = await frame();
      intervals.push(now - last);
      last = now;
    }
    send('pointerup', p.x, p.y);
    const released = performance.now();
    await c.workspace.whenIdle();
    const lag = performance.now() - released;
    intervals.sort((a, b) => a - b);
    const pct = (q: number) => intervals[Math.min(intervals.length - 1, Math.floor(q * intervals.length))]!;
    return {
      intervalP50: pct(0.5),
      intervalP95: pct(0.95),
      lagAfterRelease: lag,
      history: c.workspace.active!.history.entries.at(-1)!.label,
      isolated: self.crossOriginIsolated,
    };
  });
  console.log(JSON.stringify(r, null, 2));
  expect(r.history).toBe('Brush Tool');
  expect(r.intervalP50).toBeLessThan(17.5); // 60 fps typical while painting
  expect(r.intervalP95).toBeLessThan(25);
  expect(r.lagAfterRelease).toBeLessThan(250); // the paint keeps up with the pointer
});
