/**
 * Golden-image assertions.
 *
 * Layout: `tests/golden/<feature>/<case>.expected.png` holds the approved output
 * (real reference-app output when the owner provides it). On failure the harness
 * writes `tests/golden/__output__/<feature>/<case>.actual.png` and `.diff.png`.
 *
 * Run with UPDATE_GOLDEN=1 (`pnpm test:golden:update`) to (re)write expected images
 * after a deliberate, reviewed change.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { compareImages, type CompareOptions, type CompareResult } from './compare';
import type { RgbaImage } from './image';
import { readPng, writePng } from './png';

export const GOLDEN_ROOT = join(import.meta.dirname, '..');

export interface GoldenOptions extends CompareOptions {
  /** Directory holding feature folders (defaults to tests/golden). */
  root?: string;
  /** Directory for failure output (defaults to tests/golden/__output__). */
  outputRoot?: string;
  /** Overrides the UPDATE_GOLDEN environment variable. */
  update?: boolean;
}

export function expectGolden(
  feature: string,
  testCase: string,
  actual: RgbaImage,
  options: GoldenOptions = {},
): CompareResult | null {
  const root = options.root ?? GOLDEN_ROOT;
  const outputRoot = options.outputRoot ?? join(root, '__output__');
  const update = options.update ?? process.env['UPDATE_GOLDEN'] === '1';
  const expectedPath = join(root, feature, `${testCase}.expected.png`);

  if (update) {
    writePng(expectedPath, actual);
    return null;
  }
  if (!existsSync(expectedPath)) {
    throw new Error(
      `Missing golden image ${expectedPath}. Review the output, then run \`pnpm test:golden:update\` to create it.`,
    );
  }

  const result = compareImages(actual, readPng(expectedPath), options);
  if (!result.pass) {
    const base = join(outputRoot, feature, testCase);
    writePng(`${base}.actual.png`, actual);
    writePng(`${base}.diff.png`, result.diff);
    throw new Error(
      `Golden mismatch for ${feature}/${testCase}: ` +
        `avg ΔE00 ${result.avgDeltaE.toFixed(3)} (limit ${result.tolerance.avgDeltaE}), ` +
        `max ΔE00 ${result.maxDeltaE.toFixed(3)} at (${result.maxAt.x}, ${result.maxAt.y}) ` +
        `(limit ${result.tolerance.maxDeltaE}), ${result.failingPixels} pixel(s) over the limit. ` +
        `See ${base}.actual.png and ${base}.diff.png`,
    );
  }
  return result;
}
