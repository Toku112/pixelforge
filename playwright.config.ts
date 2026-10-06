import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env['CI'];
// Chromium is the primary target. Set PW_ALL_BROWSERS=1 to also run Firefox and WebKit (Safari engine).
const allBrowsers = !!process.env['PW_ALL_BROWSERS'];
// PW_PERF=1 runs only the performance tests, in Chromium on the real GPU.
const perf = !!process.env['PW_PERF'];
// PW_PREVIEW=1 runs the suite against a production build (served by `vite preview`).
const preview = !!process.env['PW_PREVIEW'];
const baseURL = preview ? 'http://localhost:4173' : 'http://localhost:5173';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: perf
    ? [
        {
          name: 'chromium-gpu',
          testMatch: 'perf/**/*.spec.ts',
          use: {
            ...devices['Desktop Chrome'],
            viewport: { width: 1400, height: 900 },
            launchOptions: { args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'] },
          },
        },
      ]
    : [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: 'perf/**' },
        ...(allBrowsers
          ? [
              { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: 'perf/**' },
              { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: 'perf/**' },
            ]
          : []),
      ],
  webServer: {
    command: preview ? 'PF_E2E_BUILD=1 pnpm build && pnpm preview' : 'pnpm dev',
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 300_000,
  },
});
