import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { APP_NAME } from './src/app/brand.ts';

/**
 * Cross-origin isolation headers. Required for SharedArrayBuffer, which the
 * multi-threaded WebAssembly build and shared tile memory depend on. Production
 * hosts must send the same headers (see public/_headers and README).
 */
export const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

/**
 * Sends the isolation headers on every dev/preview response. Vite's `server.headers`
 * option omits them from 304 Not Modified replies, and WebKit then refuses module
 * imports inside workers ("blocked by Cross-Origin-Embedder-Policy").
 */
export function crossOriginIsolation(): Plugin {
  const middleware: Connect.NextHandleFunction = (_req, res, next) => {
    for (const [name, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) res.setHeader(name, value);
    next();
  };
  return {
    name: 'pixelforge-cross-origin-isolation',
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

/** Injects the single-source product name into index.html. */
function brandHtml(): Plugin {
  return {
    name: 'pixelforge-brand-html',
    transformIndexHtml: (html) => html.replaceAll('%APP_NAME%', APP_NAME),
  };
}

/**
 * `PF_E2E_BUILD=1` adds the test harness pages to a production build so the
 * end-to-end tests can also run against bundled output (`pnpm test:e2e:preview`).
 * Normal builds never include them.
 */
function buildInputs(): Record<string, string> | undefined {
  if (process.env['PF_E2E_BUILD'] !== '1') return undefined;
  const harnessDir = resolve(import.meta.dirname, 'tests/e2e/harness');
  const inputs: Record<string, string> = { main: resolve(import.meta.dirname, 'index.html') };
  for (const file of readdirSync(harnessDir)) {
    if (file.endsWith('.html')) inputs[`harness-${file.slice(0, -5)}`] = resolve(harnessDir, file);
  }
  return inputs;
}

const packageVersion = (JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version: string }).version;

export default defineConfig({
  plugins: [crossOriginIsolation(), react(), brandHtml()],
  define: {
    __APP_VERSION__: JSON.stringify(packageVersion),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2023',
    sourcemap: true,
    rollupOptions: { input: buildInputs() },
  },
  worker: {
    format: 'es',
  },
});
