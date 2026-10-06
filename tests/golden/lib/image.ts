/**
 * Image type used by the golden-image harness: interleaved RGBA with straight
 * (non-premultiplied) alpha.
 *  - depth 8 / 16: gamma-encoded sRGB code values (0–255 / 0–65535)
 *  - depth 32: linear-light floats (1.0 = white, may exceed 1)
 */
export type SampleArray = Uint8Array | Uint16Array | Float32Array;

export interface RgbaImage {
  width: number;
  height: number;
  depth: 8 | 16 | 32;
  data: SampleArray;
}

export function createImage(width: number, height: number, depth: 8 | 16 | 32): RgbaImage {
  const n = width * height * 4;
  const data = depth === 8 ? new Uint8Array(n) : depth === 16 ? new Uint16Array(n) : new Float32Array(n);
  return { width, height, depth, data };
}

/** Fills an image from a function returning normalised RGBA (0–1; linear for depth 32). */
export function fillImage(
  image: RgbaImage,
  fn: (x: number, y: number) => readonly [number, number, number, number],
): RgbaImage {
  const max = image.depth === 8 ? 255 : image.depth === 16 ? 65535 : 1;
  const round = image.depth !== 32;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const px = fn(x, y);
      const i = (y * image.width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v = (px[c] ?? 0) * max;
        image.data[i + c] = round ? Math.round(Math.min(max, Math.max(0, v))) : v;
      }
    }
  }
  return image;
}
