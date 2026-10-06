import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import config, { CROSS_ORIGIN_ISOLATION_HEADERS } from '../../../vite.config';

describe('cross-origin isolation headers', () => {
  it('are the COOP/COEP pair required for SharedArrayBuffer', () => {
    expect(CROSS_ORIGIN_ISOLATION_HEADERS).toEqual({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
  });

  it('are installed on both the dev server and the production preview server', () => {
    const plugins = (config as { plugins?: Plugin[] }).plugins ?? [];
    const plugin = plugins.find((p) => p.name === 'pixelforge-cross-origin-isolation');
    expect(plugin?.configureServer).toBeTypeOf('function');
    expect(plugin?.configurePreviewServer).toBeTypeOf('function');
  });

  it('are declared for static hosts in public/_headers', () => {
    const rules = readFileSync(join(import.meta.dirname, '../../../public/_headers'), 'utf8');
    for (const [name, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) {
      expect(rules).toContain(`${name}: ${value}`);
    }
  });
});
