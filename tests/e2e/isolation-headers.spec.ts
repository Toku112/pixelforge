import { expect, test } from '@playwright/test';

// Every response — including 304 Not Modified revalidations — must carry COOP/COEP,
// otherwise WebKit blocks module imports inside workers.
const devOnlyPaths = process.env['PW_PREVIEW'] ? [] : ['/src/workers/pixel.worker.ts', '/@vite/env'];

test('server sends isolation headers on fresh and 304 responses', async ({ request }) => {
  for (const path of ['/', '/tests/e2e/harness/wasm.html', ...devOnlyPaths]) {
    const fresh = await request.get(path);
    expect(fresh.status(), path).toBe(200);
    expect(fresh.headers()['cross-origin-opener-policy'], path).toBe('same-origin');
    expect(fresh.headers()['cross-origin-embedder-policy'], path).toBe('require-corp');

    const etag = fresh.headers()['etag'];
    if (!etag) continue;
    const revalidated = await request.get(path, { headers: { 'If-None-Match': etag } });
    expect(revalidated.status(), path).toBe(304);
    expect(revalidated.headers()['cross-origin-opener-policy'], path).toBe('same-origin');
    expect(revalidated.headers()['cross-origin-embedder-policy'], path).toBe('require-corp');
  }
});
