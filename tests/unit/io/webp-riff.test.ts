import { describe, expect, it } from 'vitest';
import { withIccProfile } from '../../../src/io/webp-riff';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** A RIFF WebP made of chunks (contents are not decoded by the helper). */
function riff(chunks: [string, number[]][]): Uint8Array {
  const body: number[] = [];
  for (const [tag, data] of chunks) {
    const size = data.length;
    body.push(...ascii(tag), size & 0xff, (size >> 8) & 0xff, 0, 0, ...data);
    if (size % 2) body.push(0);
  }
  const size = 4 + body.length;
  return new Uint8Array([...ascii('RIFF'), size & 0xff, (size >> 8) & 0xff, 0, 0, ...ascii('WEBP'), ...body]);
}

function chunksOf(file: Uint8Array): [string, number[]][] {
  const out: [string, number[]][] = [];
  for (let o = 12; o + 8 <= file.length;) {
    const tag = String.fromCharCode(...file.subarray(o, o + 4));
    const size = file[o + 4]! | (file[o + 5]! << 8);
    out.push([tag, [...file.subarray(o + 8, o + 8 + size)]]);
    o += 8 + size + (size % 2);
  }
  return out;
}

describe('WebP ICC profiles', () => {
  it('turns a simple lossy file into the extended format with the profile', () => {
    const file = withIccProfile(riff([['VP8 ', [1, 2, 3]]]), new Uint8Array([9, 9, 9, 9, 9]), 300, 2);
    const chunks = chunksOf(file);
    expect(chunks.map((c) => c[0])).toEqual(['VP8X', 'ICCP', 'VP8 ']);
    // Flags: ICC (0x20), no alpha; canvas 300 × 2 stored as width − 1, height − 1.
    expect(chunks[0]![1]).toEqual([0x20, 0, 0, 0, 43, 1, 0, 1, 0, 0]);
    expect(chunks[1]![1]).toEqual([9, 9, 9, 9, 9]);
    expect(chunks[2]![1]).toEqual([1, 2, 3]);
    const size = file[4]! | (file[5]! << 8);
    expect(size).toBe(file.length - 8);
  });

  it('keeps an existing VP8X (with alpha) and replaces an old profile', () => {
    const file = withIccProfile(
      riff([
        ['VP8X', [0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
        ['ICCP', [1]],
        ['ALPH', [5]],
        ['VP8 ', [6]],
      ]),
      new Uint8Array([7, 7]),
      1,
      1,
    );
    const chunks = chunksOf(file);
    expect(chunks.map((c) => c[0])).toEqual(['VP8X', 'ICCP', 'ALPH', 'VP8 ']);
    expect(chunks[0]![1][0]).toBe(0x30);
    expect(chunks[1]![1]).toEqual([7, 7]);
  });

  it('marks alpha for a lossless bitstream that has it', () => {
    // VP8L: signature byte, then 14-bit width − 1, 14-bit height − 1, then the alpha bit (bit 28).
    const file = withIccProfile(riff([['VP8L', [0x2f, 0, 0, 0, 0x10]]]), new Uint8Array([1]), 1, 1);
    expect(chunksOf(file)[0]![1][0]).toBe(0x30);
  });
});
