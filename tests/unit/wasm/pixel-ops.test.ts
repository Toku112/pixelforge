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
    expect(px).toEqual(copy);
  });

  it('throws a readable error for invalid layouts', () => {
    expect(() => ops.invertU8(new Uint8Array(5), 4, true)).toThrow('not a multiple of the channel count');
  });
});
