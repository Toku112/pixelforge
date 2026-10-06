/**
 * Pixel formats (docs/FORMAT_NOTES.md §1).
 *
 * Pixels are stored interleaved: the colour channels of the document's colour
 * mode, followed by an alpha channel when the buffer has transparency. Alpha is
 * straight (not premultiplied), as in PSD files.
 *  - 8-bit:  Uint8   0–255
 *  - 16-bit: Uint16  0–65535 (PSD's 0–32768 range is converted on I/O)
 *  - 32-bit: Float32 linear light, 1.0 = white, values above 1 allowed (HDR)
 */

export type BitDepth = 8 | 16 | 32;

export type ColorMode = 'bitmap' | 'grayscale' | 'duotone' | 'indexed' | 'rgb' | 'cmyk' | 'lab' | 'multichannel';

export type SampleArray = Uint8Array | Uint16Array | Float32Array;

/** Number of colour channels (excluding alpha) for a colour mode. */
export function colorChannelCount(mode: ColorMode, multichannelCount = 1): number {
  switch (mode) {
    case 'bitmap':
    case 'grayscale':
    case 'duotone':
    case 'indexed':
      return 1;
    case 'rgb':
    case 'lab':
      return 3;
    case 'cmyk':
      return 4;
    case 'multichannel':
      return multichannelCount;
  }
}

export interface PixelFormat {
  readonly depth: BitDepth;
  /** Colour channels, excluding alpha. */
  readonly colorChannels: number;
  readonly hasAlpha: boolean;
}

/** Total interleaved samples per pixel. */
export function samplesPerPixel(format: PixelFormat): number {
  return format.colorChannels + (format.hasAlpha ? 1 : 0);
}

export function bytesPerSample(depth: BitDepth): number {
  return depth === 8 ? 1 : depth === 16 ? 2 : 4;
}

/** Sample value meaning "full intensity" / "fully opaque". */
export function maxSampleValue(depth: BitDepth): number {
  return depth === 8 ? 255 : depth === 16 ? 65535 : 1;
}

/** Creates a sample array for `depth`, optionally as a view onto an existing buffer. */
export function createSampleArray(depth: BitDepth, length: number, buffer?: ArrayBufferLike): SampleArray {
  if (buffer) {
    if (depth === 8) return new Uint8Array(buffer, 0, length);
    if (depth === 16) return new Uint16Array(buffer, 0, length);
    return new Float32Array(buffer, 0, length);
  }
  if (depth === 8) return new Uint8Array(length);
  if (depth === 16) return new Uint16Array(length);
  return new Float32Array(length);
}

export function formatsEqual(a: PixelFormat, b: PixelFormat): boolean {
  return a.depth === b.depth && a.colorChannels === b.colorChannels && a.hasAlpha === b.hasAlpha;
}

/** Copies `src` into `dst` at `offset` (both arrays must have the same sample type). */
export function copySamples(dst: SampleArray, src: SampleArray, offset = 0): void {
  (dst as Uint8Array).set(src, offset);
}
