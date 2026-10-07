import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, * as ops from '../../../src/wasm/pkg/pixel-ops-st/pixel_ops.js';

const PKG = join(import.meta.dirname, '../../../src/wasm/pkg/pixel-ops-st');

beforeAll(async () => {
  await init({ module_or_path: readFileSync(join(PKG, 'pixel_ops_bg.wasm')) });
});

describe('pixel-ops WebAssembly (single-threaded build)', () => {
  it('is built with SIMD and without threads', () => {
    expect(ops.simdEnabled()).toBe(true);
    expect(ops.threadsEnabled()).toBe(false);
    expect(ops.threadCount()).toBe(1);
  });

  it('inverts 8-bit RGBA colour and keeps alpha', () => {
    const px = new Uint8Array([0, 128, 255, 77, 10, 20, 30, 0]);
    ops.invertU8(px, 4, true);
    expect([...px]).toEqual([255, 127, 0, 77, 245, 235, 225, 0]);
  });

  it('inverts 16-bit samples over the full 0–65535 range', () => {
    const px = new Uint16Array([0, 32768, 65535, 1234]);
    ops.invertU16(px, 4, true);
    expect([...px]).toEqual([65535, 32767, 0, 1234]);
  });

  it('round-trips a large buffer', () => {
    const px = new Uint8Array(4 * 1_000_003);
    for (let i = 0; i < px.length; i++) px[i] = (i * 31) % 251;
    const copy = px.slice();
    ops.invertU8(px, 4, true);
    ops.invertU8(px, 4, true);
    // Every byte compared, without the generic deep equality (seconds for 4 MB, which made this test flaky).
    expect(Buffer.compare(px, copy)).toBe(0);
  });

  it('throws a readable error for invalid layouts', () => {
    expect(() => ops.invertU8(new Uint8Array(5), 4, true)).toThrow('not a multiple of the channel count');
  });
});

describe('pixel-ops WebAssembly matches the reference implementation', () => {
  it.each([
    [8, 4, true],
    [8, 3, false],
    [8, 2, true],
    [16, 4, true],
    [16, 5, true],
  ] as const)('%i-bit, %i channels, alpha=%s', async (depth, channels, hasAlpha) => {
    const { referencePixelOps } = await import('../core/helpers');
    const n = 256 * 256 * channels;
    const max = depth === 8 ? 256 : 65536;
    const a = depth === 8 ? new Uint8Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) a[i] = (i * 2654435761) % max;
    const b = a.slice();
    if (a instanceof Uint8Array) ops.invertU8(a, channels, hasAlpha);
    else ops.invertU16(a, channels, hasAlpha);
    await referencePixelOps.invert([b], { depth, colorChannels: hasAlpha ? channels - 1 : channels, hasAlpha });
    expect(a).toEqual(b);
  });
});
