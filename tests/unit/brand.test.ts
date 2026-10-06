import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_NAME } from '../../src/app/brand';

const ROOT = join(import.meta.dirname, '..', '..');

// CLAUDE.md §1.1: these names must never appear in product UI, file names or code.
// Descriptive references (e.g. "Photoshop-compatible shortcuts" in a settings label)
// are allowed only on lines carrying an explicit `brand-allow: descriptive` marker.
const FORBIDDEN = /\b(adobe|photoshop|firefly|creative\s*cloud)\b/i;
const ALLOW_MARKER = 'brand-allow: descriptive';

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'pkg' || entry === 'target') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('branding', () => {
  it('has a non-empty product name that is not a protected brand', () => {
    expect(APP_NAME.trim().length).toBeGreaterThan(0);
    expect(APP_NAME).not.toMatch(FORBIDDEN);
  });

  it('never uses protected brand names in shipped source, assets or file names', () => {
    const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'public')), join(ROOT, 'index.html')];
    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (FORBIDDEN.test(rel)) violations.push(`${rel}: file name`);
      if (!/\.(ts|tsx|js|css|html|json|svg|md|txt|rs|toml)$/.test(file)) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (FORBIDDEN.test(line) && !line.includes(ALLOW_MARKER)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(violations).toEqual([]);
  });
});
