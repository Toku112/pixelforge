import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base, type Page } from '@playwright/test';

// OPFS needs a persistent browser profile (private/ephemeral contexts, like Safari
// private windows, have none), so these tests launch one per test.
const test = base.extend<{ persistentPage: Page }>({
  persistentPage: async ({ playwright, browserName, baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-opfs-'));
    const context = await playwright[browserName].launchPersistentContext(dir, { baseURL });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('/tests/e2e/harness/tiles.html');
    await page.waitForFunction(() => window.__tiles !== undefined);
    await use(page);
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  },
});

test('undo data moves to the OPFS scratch disk and comes back on undo/redo', async ({ persistentPage: page }) => {
  const r = await page.evaluate(() => window.__tiles!.undoThroughScratchDisk());
  expect(r.shared).toBe(true); // tiles live in shared memory
  expect(r.afterRuns.pixel).toBe(0); // white inverted 5 times → black
  expect(r.afterRuns.store.swappedTiles).toBeGreaterThan(0);
  expect(r.afterRuns.disk.bytesOnDisk).toBeGreaterThan(0);
  expect(r.atStart).toBe(255);
  expect(r.atEnd).toBe(0);
  expect(r.atTwo).toBe(255);
  expect(r.reloads).toBeGreaterThan(0);
});

test('scratch folders of closed sessions are cleaned up; a session removes its own on dispose', async ({
  persistentPage: page,
}) => {
  const r = await page.evaluate(() => window.__tiles!.staleFolderCleanup());
  expect(r.folders).toContain(r.session);
  expect(r.folders).not.toContain('left-over-session');
  expect(r.afterDispose).not.toContain(r.session);
});

test('without OPFS (private browsing in WebKit) the scratch disk reports unavailable', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'Only WebKit lacks OPFS in ephemeral contexts');
  await page.goto('/tests/e2e/harness/tiles.html');
  await page.waitForFunction(() => window.__tiles !== undefined);
  expect(await page.evaluate(() => window.__tiles!.scratchDiskAvailable())).toBe(false);
});
