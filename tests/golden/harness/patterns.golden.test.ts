// Self-test of the golden pipeline: deterministic patterns rendered in code must
// match the committed expected PNGs (exercises PNG I/O and the ΔE comparison end to end).
import { describe, it } from 'vitest';
import { expectGolden } from '../lib/golden';
import { createImage, fillImage } from '../lib/image';

const pattern = (x: number, y: number) => [x / 63, y / 63, ((x ^ y) & 15) / 15, 0.25 + 0.75 * ((x + y) / 126)] as const;

describe('golden harness self-test', () => {
  it('8-bit pattern', () => {
    expectGolden('harness', 'pattern-8bit', fillImage(createImage(64, 64, 8), pattern));
  });

  it('16-bit pattern', () => {
    expectGolden('harness', 'pattern-16bit', fillImage(createImage(64, 64, 16), pattern));
  });
});
