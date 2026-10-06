/** PNG read/write for test images (8- and 16-bit RGBA), via pngjs. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pngjs from 'pngjs';
import type { RgbaImage } from './image';

const { PNG } = pngjs;

export function readPng(path: string): RgbaImage {
  const png = PNG.sync.read(readFileSync(path), { skipRescale: true });
  const depth = png.depth === 16 ? 16 : 8;
  if (png.depth !== 8 && png.depth !== 16) {
    // pngjs expands 1/2/4-bit images to 8-bit samples.
    return { width: png.width, height: png.height, depth: 8, data: new Uint8Array(png.data) };
  }
  const data = depth === 16 ? new Uint16Array(png.data) : new Uint8Array(png.data as Uint8Array);
  return { width: png.width, height: png.height, depth, data };
}

export function writePng(path: string, image: RgbaImage): void {
  if (image.depth === 32) throw new Error('writePng: 32-bit float images cannot be stored as PNG');
  const png = new PNG({ width: image.width, height: image.height, bitDepth: image.depth, colorType: 6 });
  png.data =
    image.depth === 16
      ? (image.data as unknown as Buffer)
      : Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG.sync.write(png, { bitDepth: image.depth, colorType: 6, inputHasAlpha: true }));
}
