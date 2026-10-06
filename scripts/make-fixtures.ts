/**
 * Generates the image fixtures in tests/fixtures/images/. All images are synthetic
 * patterns drawn by this script (no third-party images).
 *
 *  - PNG files are written by a minimal PNG writer below, so every byte is controlled.
 *  - JPEG and WebP files are encoded by headless Chromium (Playwright), and Chromium's
 *    own decode of each file is saved as `<name>.expected.png` for comparison.
 *
 * Run: node scripts/make-fixtures.ts   (re-run only when fixtures need to change)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const OUT = join(import.meta.dirname, '..', 'tests', 'fixtures', 'images');

// --- Minimal PNG writer -------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

interface PngSpec {
  width: number;
  height: number;
  colorType: 0 | 2 | 3 | 4 | 6;
  bitDepth: 8 | 16;
  /** Samples per row-major pixel; for 16-bit, values 0–65535. */
  samples: number[];
  palette?: number[];
  trns?: number[];
  ppi?: number;
}

function writePng(spec: PngSpec): Uint8Array {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[spec.colorType];
  const bytesPerSample = spec.bitDepth / 8;
  const stride = spec.width * channels * bytesPerSample;
  const raw = new Uint8Array((stride + 1) * spec.height);
  for (let y = 0; y < spec.height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let i = 0; i < spec.width * channels; i++) {
      const v = spec.samples[y * spec.width * channels + i]!;
      const o = y * (stride + 1) + 1 + i * bytesPerSample;
      if (bytesPerSample === 2) {
        raw[o] = v >> 8;
        raw[o + 1] = v & 0xff;
      } else raw[o] = v;
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, spec.width);
  v.setUint32(4, spec.height);
  ihdr.set([spec.bitDepth, spec.colorType, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (spec.ppi) {
    const phys = new Uint8Array(9);
    const ppm = Math.round(spec.ppi / 0.0254);
    new DataView(phys.buffer).setUint32(0, ppm);
    new DataView(phys.buffer).setUint32(4, ppm);
    phys[8] = 1;
    parts.push(chunk('pHYs', phys));
  }
  if (spec.palette) parts.push(chunk('PLTE', new Uint8Array(spec.palette)));
  if (spec.trns) parts.push(chunk('tRNS', new Uint8Array(spec.trns)));
  parts.push(chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array()));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Deterministic test pattern: gradients plus a checker, values 0–1. */
function pattern(x: number, y: number, w: number, h: number): [number, number, number] {
  const checker = ((x >> 3) + (y >> 3)) & 1;
  return [x / (w - 1), y / (h - 1), checker ? 0.85 : 0.15];
}

function makePngs(): void {
  const w = 64;
  const h = 48;
  const px = (fn: (x: number, y: number) => number[]) => {
    const out: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push(...fn(x, y));
    return out;
  };
  const files: Record<string, PngSpec> = {
    'rgb8.png': {
      width: w,
      height: h,
      colorType: 2,
      bitDepth: 8,
      ppi: 300,
      samples: px((x, y) => pattern(x, y, w, h).map((c) => Math.round(c * 255))),
    },
    'rgba8.png': {
      width: w,
      height: h,
      colorType: 6,
      bitDepth: 8,
      samples: px((x, y) => [
        ...pattern(x, y, w, h).map((c) => Math.round(c * 255)),
        x < 16 ? 0 : Math.round(((x - 16) / (w - 17)) * 255),
      ]),
    },
    'rgb16.png': {
      width: w,
      height: h,
      colorType: 2,
      bitDepth: 16,
      samples: px((x, y) => pattern(x, y, w, h).map((c) => Math.round(c * 65535))),
    },
    'gray8.png': {
      width: w,
      height: h,
      colorType: 0,
      bitDepth: 8,
      samples: px((x) => [Math.round((x / (w - 1)) * 255)]),
    },
    'graya16.png': {
      width: w,
      height: h,
      colorType: 4,
      bitDepth: 16,
      samples: px((x, y) => [Math.round((x / (w - 1)) * 65535), Math.round((y / (h - 1)) * 65535)]),
    },
    'palette.png': {
      width: w,
      height: h,
      colorType: 3,
      bitDepth: 8,
      palette: [255, 0, 0, 0, 160, 0, 0, 0, 255, 255, 255, 255],
      trns: [255, 255, 255, 0],
      samples: px((x, y) => [((x >> 4) + (y >> 4)) & 3]),
    },
    // Large enough to span several 256-px tiles, with a transparent quarter.
    'tiles-rgba8.png': {
      width: 600,
      height: 300,
      colorType: 6,
      bitDepth: 8,
      samples: (() => {
        const out: number[] = [];
        for (let y = 0; y < 300; y++)
          for (let x = 0; x < 600; x++) out.push(x % 256, y % 256, (x + y) % 256, x >= 512 && y < 256 ? 0 : 255);
        return out;
      })(),
    },
  };
  for (const [name, spec] of Object.entries(files)) writeFileSync(join(OUT, name), writePng(spec));
}

// --- JPEG / WebP via Chromium -------------------------------------------------

/** Inserts an EXIF APP1 segment with the given orientation after the JFIF APP0 segment. */
function withExifOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = new Uint8Array([
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00, // "II", 42, IFD at 8
    0x01,
    0x00, // one entry
    0x12,
    0x01,
    0x03,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00, // Orientation SHORT
    0x00,
    0x00,
    0x00,
    0x00, // no next IFD
  ]);
  const payload = new Uint8Array([...new TextEncoder().encode('Exif\0\0'), ...tiff]);
  const length = payload.length + 2;
  const app1 = new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff, ...payload]);
  // Skip SOI and, if present, APP0 (JFIF).
  let insertAt = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) insertAt = 4 + ((jpeg[4]! << 8) | jpeg[5]!);
  return new Uint8Array([...jpeg.subarray(0, insertAt), ...app1, ...jpeg.subarray(insertAt)]);
}

async function makeBrowserEncoded(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');
  const encode = (type: string, quality: number, alpha: boolean) =>
    page.evaluate(
      async ({ type, quality, alpha }) => {
        const w = 96;
        const h = 64;
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d')!;
        const img = ctx.createImageData(w, h);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const checker = ((x >> 3) + (y >> 3)) & 1;
            img.data[i] = Math.round((x / (w - 1)) * 255);
            img.data[i + 1] = Math.round((y / (h - 1)) * 255);
            img.data[i + 2] = checker ? 217 : 38;
            img.data[i + 3] = alpha ? (x < 24 ? 0 : 255) : 255;
          }
        ctx.putImageData(img, 0, 0);
        const blob = await canvas.convertToBlob({ type, quality });
        return [...new Uint8Array(await blob.arrayBuffer())];
      },
      { type, quality, alpha },
    );
  /** Chromium's decode of `bytes` (applying EXIF orientation) as RGBA. */
  const decodeInBrowser = (bytes: Uint8Array, mime: string) =>
    page.evaluate(
      async ({ bytes, mime }) => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }), {
          imageOrientation: 'from-image',
          premultiplyAlpha: 'none',
          colorSpaceConversion: 'none',
        });
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        return {
          width: bitmap.width,
          height: bitmap.height,
          data: [...ctx.getImageData(0, 0, bitmap.width, bitmap.height).data],
        };
      },
      { bytes: [...bytes], mime },
    );

  const outputs: [string, Uint8Array, string][] = [];
  const jpeg = new Uint8Array(await encode('image/jpeg', 0.92, false));
  outputs.push(['photo.jpg', jpeg, 'image/jpeg']);
  outputs.push(['photo-orient6.jpg', withExifOrientation(jpeg, 6), 'image/jpeg']);
  outputs.push(['alpha.webp', new Uint8Array(await encode('image/webp', 0.9, true)), 'image/webp']);

  for (const [name, bytes, mime] of outputs) {
    writeFileSync(join(OUT, name), bytes);
    const decoded = await decodeInBrowser(bytes, mime);
    writeFileSync(
      join(OUT, name.replace(/\.\w+$/, '.expected.png')),
      writePng({ width: decoded.width, height: decoded.height, colorType: 6, bitDepth: 8, samples: decoded.data }),
    );
  }
  await browser.close();
}

mkdirSync(OUT, { recursive: true });
makePngs();
await makeBrowserEncoded();
console.log(`Fixtures written to ${OUT}`);
