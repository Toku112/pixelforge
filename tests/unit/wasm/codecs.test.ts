import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, * as codecs from '../../../src/wasm/pkg/codecs-st/codecs.js';
import { compareImages } from '../../golden/lib/compare';
import type { RgbaImage } from '../../golden/lib/image';
import { readPng } from '../../golden/lib/png';

const FIXTURES = join(import.meta.dirname, '../../fixtures/images');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

beforeAll(async () => {
  await init({
    module_or_path: readFileSync(join(import.meta.dirname, '../../../src/wasm/pkg/codecs-st/codecs_bg.wasm')),
  });
});

function decode(name: string) {
  const img = codecs.decodeImage(fixture(name));
  const info = {
    format: img.format,
    width: img.width,
    height: img.height,
    channels: img.channels,
    depth: img.depth,
    ppi: img.ppiX,
  };
  const data = img.depth === 16 ? img.takeData16() : img.takeData8();
  img.free();
  return { ...info, data };
}

/** Expands gray/gray+alpha/RGB 8-bit samples to RGBA for comparison. */
function toRgba(d: ReturnType<typeof decode>): RgbaImage {
  const out = new Uint8Array(d.width * d.height * 4);
  for (let p = 0; p < d.width * d.height; p++) {
    const s = d.data.subarray(p * d.channels, (p + 1) * d.channels);
    const [r, g, b, a] =
      d.channels === 1
        ? [s[0], s[0], s[0], 255]
        : d.channels === 2
          ? [s[0], s[0], s[0], s[1]]
          : d.channels === 3
            ? [s[0], s[1], s[2], 255]
            : [s[0], s[1], s[2], s[3]];
    out.set([r!, g!, b!, a!], p * 4);
  }
  return { width: d.width, height: d.height, depth: 8, data: out };
}

describe('codecs WebAssembly — PNG', () => {
  it('detects formats', () => {
    expect(codecs.detectFormat(fixture('rgb8.png'))).toBe('png');
    expect(codecs.detectFormat(fixture('photo.jpg'))).toBe('jpeg');
    expect(codecs.detectFormat(fixture('alpha.webp'))).toBe('webp');
    expect(codecs.detectFormat(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it('decodes 8-bit RGB with its resolution', () => {
    const d = decode('rgb8.png');
    expect(d).toMatchObject({ format: 'png', width: 64, height: 48, channels: 3, depth: 8 });
    expect(d.ppi).toBeCloseTo(300, 1);
    expect([...d.data.subarray(0, 3)]).toEqual([0, 0, 38]); // pattern at (0,0)
  });

  it('decodes 8-bit RGBA, 16-bit RGB, gray and gray+alpha 16-bit', () => {
    expect(decode('rgba8.png')).toMatchObject({ channels: 4, depth: 8 });
    const rgb16 = decode('rgb16.png');
    expect(rgb16).toMatchObject({ channels: 3, depth: 16 });
    expect(rgb16.data).toBeInstanceOf(Uint16Array);
    expect(rgb16.data[(47 * 64 + 63) * 3]).toBe(65535);
    expect(decode('gray8.png')).toMatchObject({ channels: 1, depth: 8 });
    const ga = decode('graya16.png');
    expect(ga).toMatchObject({ channels: 2, depth: 16 });
    expect(ga.data[(47 * 64 + 63) * 2 + 1]).toBe(65535);
  });

  it('expands palette images with transparency to RGBA', () => {
    const d = decode('palette.png');
    expect(d).toMatchObject({ channels: 4, depth: 8 });
    expect([...d.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]); // index 0
    const i = (16 * 64 + 16) * 4; // ((16>>4)+(16>>4))&3 = 2 → blue
    expect([...d.data.subarray(i, i + 4)]).toEqual([0, 0, 255, 255]);
    const j = (16 * 64 + 32) * 4; // (2+1)&3 = 3 → transparent white
    expect(d.data[j + 3]).toBe(0);
  });

  it('round-trips 8- and 16-bit PNG encoding with resolution and ICC profile', () => {
    const icc = new Uint8Array([1, 2, 3, 4, 5]);
    const data8 = new Uint8Array(4 * 3 * 4).map((_, i) => (i * 17) % 256);
    const png8 = codecs.encodePng8(data8, 4, 3, 4, 240, icc, 3);
    const back8 = codecs.decodeImage(png8);
    expect([back8.width, back8.height, back8.channels, back8.depth]).toEqual([4, 3, 4, 8]);
    expect(back8.ppiX).toBeCloseTo(240, 1);
    expect([...back8.iccProfile!]).toEqual([...icc]);
    expect(back8.takeData8()).toEqual(data8);

    const data16 = new Uint16Array(5 * 2 * 3).map((_, i) => (i * 4099) % 65536);
    const back16 = codecs.decodeImage(codecs.encodePng16(data16, 5, 2, 3, 0, undefined, 1));
    expect(back16.ppiX).toBe(0);
    expect(back16.iccProfile).toBeUndefined();
    expect(back16.takeData16()).toEqual(data16);
  });

  it('reports readable errors', () => {
    expect(() => codecs.decodeImage(new Uint8Array([0, 1, 2, 3]))).toThrow('Unrecognised file format');
    const png = fixture('rgb8.png');
    expect(() => codecs.decodeImage(png.subarray(0, 60))).toThrow(/Invalid PNG/);
  });
});

describe('codecs WebAssembly — JPEG and WebP (compared with Chromium’s decoder)', () => {
  it.each([
    ['photo.jpg', 'photo.expected.png', 96, 64],
    ['photo-orient6.jpg', 'photo-orient6.expected.png', 64, 96], // EXIF orientation 6 → rotated 90° clockwise
    ['alpha.webp', 'alpha.expected.png', 96, 64],
  ])('%s matches the reference decode', (file, expectedFile, w, h) => {
    const d = decode(file);
    expect([d.width, d.height]).toEqual([w, h]);
    const result = compareImages(toRgba(d), readPng(join(FIXTURES, expectedFile)));
    expect(result.pass, `avg ${result.avgDeltaE.toFixed(3)} max ${result.maxDeltaE.toFixed(3)}`).toBe(true);
  });

  it('decodes WebP transparency', () => {
    const d = decode('alpha.webp');
    expect(d.channels).toBe(4);
    expect(d.data[3]).toBe(0); // x < 24 is transparent
    expect(d.data[(10 * 96 + 50) * 4 + 3]).toBe(255);
  });
});
