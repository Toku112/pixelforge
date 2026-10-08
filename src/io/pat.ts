/**
 * Pattern files of the reference app (.pat): a list of patterns, each an image in
 * the "virtual memory array list" layout of its PSD format (FORMAT_NOTES §12). We
 * read RGB, Grayscale, Indexed, CMYK and Lab patterns with 8 or 16 bits per channel,
 * raw or RLE-compressed, with their transparency; and write RGB(A) patterns.
 *
 * Colours become sRGB like swatch files: CMYK by the simple uncalibrated formula,
 * Lab through D65 sRGB, until colour management (Phase 7). Other modes (bitmap,
 * duotone, multichannel) are skipped and listed in `notes`.
 */
import { labToRgb } from '../core/color/color';
import type { Pattern } from '../core/pattern/pattern';
import { DescriptorReader, DescriptorWriter } from './descriptor';
import { cmykToRgb } from './swatch-files';

export interface PatImport {
  patterns: Pattern[];
  notes: string[];
}

/** Image modes as the file numbers them. */
const MODES: Record<number, string> = {
  0: 'Bitmap',
  1: 'Grayscale',
  2: 'Indexed',
  3: 'RGB',
  4: 'CMYK',
  7: 'Multichannel',
  8: 'Duotone',
  9: 'Lab',
};
const COLOR_CHANNELS: Record<number, number> = { 1: 1, 2: 1, 3: 3, 4: 4, 9: 3 };

/** PackBits: n ≥ 0 copies n + 1 bytes, n in −127…−1 repeats the next byte 1 − n times. */
function unpackBits(src: Uint8Array, out: Uint8Array, start: number, length: number): number {
  let i = start;
  let o = 0;
  while (o < length && i < src.length) {
    const n = (src[i++]! << 24) >> 24;
    if (n >= 0) {
      for (let k = 0; k <= n && o < length; k++) out[o++] = src[i++]!;
    } else if (n !== -128) {
      const v = src[i++]!;
      for (let k = 0; k < 1 - n && o < length; k++) out[o++] = v;
    }
  }
  return i;
}

interface Channel {
  /** 8-bit values over its rectangle. */
  values: Uint8Array;
  x: number;
  y: number;
  w: number;
  h: number;
}

function readChannel(r: DescriptorReader): Channel | null {
  if (r.u32() === 0) return null; // not written
  const length = r.u32();
  if (length === 0) return null;
  const end = r.offset + length;
  const depth = r.u32();
  const top = r.u32();
  const left = r.u32();
  const bottom = r.u32();
  const right = r.u32();
  r.u16(); // the depth again
  const compression = r.u8();
  const w = right - left;
  const h = bottom - top;
  if (depth !== 8 && depth !== 16) throw new Error(`Patterns with ${depth} bits per channel cannot be read`);
  const bytes = depth / 8;
  const data = r.bytes(end - r.offset);
  const raw = new Uint8Array(w * h * bytes);
  if (compression === 0) raw.set(data.subarray(0, raw.length));
  else if (compression === 1) {
    // Row byte counts, then the rows.
    let at = h * 2;
    for (let y = 0; y < h; y++) at = unpackBits(data, raw.subarray(y * w * bytes), at, w * bytes);
  } else throw new Error('The pattern uses a compression that cannot be read');
  // 16-bit: the high byte of each big-endian value.
  const values = bytes === 1 ? raw : Uint8Array.from({ length: w * h }, (_, i) => raw[i * 2]!);
  return { values, x: left, y: top, w, h };
}

function readPattern(r: DescriptorReader, notes: Set<string>, index: number): Pattern | null {
  // The version (1), possibly after padding to a 4-byte boundary or after the pattern's length.
  const start = r.offset;
  let found = false;
  for (let skip = 0; skip < 4 && !found && r.left >= skip + 4; skip++) {
    r.offset = start + skip;
    found = r.u32() === 1;
  }
  if (!found) {
    r.offset = start;
    r.u32(); // a length
    if (r.u32() !== 1) throw new Error('The pattern file is damaged');
  }
  const mode = r.u32();
  const height = r.u16();
  const width = r.u16();
  const name = r.unicode() || `Pattern ${index + 1}`;
  const idLength = r.u8();
  r.ascii(idLength); // the file's own id: ours are new
  let palette: Uint8Array | null = null;
  if (mode === 2) {
    palette = r.bytes(768);
    r.bytes(4);
  }
  // The virtual memory array list.
  if (r.u32() !== 3) throw new Error('The pattern file is damaged');
  const listLength = r.u32();
  const listEnd = r.offset + listLength;
  const top = r.u32();
  const left = r.u32();
  const bottom = r.u32();
  const right = r.u32();
  const count = r.u32();
  const channels: Channel[] = [];
  for (let i = 0; i < count + 2 && r.offset < listEnd; i++) {
    const c = readChannel(r);
    if (c) channels.push(c);
  }
  r.offset = listEnd;
  const cc = COLOR_CHANNELS[mode];
  if (cc === undefined) {
    notes.add(
      `${MODES[mode] ?? 'Unknown'} patterns were left out (only RGB, Grayscale, Indexed, CMYK and Lab are read).`,
    );
    return null;
  }
  const w = right - left || width;
  const h = bottom - top || height;
  const data = new Uint8Array(w * h * 4);
  // Where a channel has no data: no colour, fully opaque.
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const plane = (k: number): Uint8Array | null => {
    const c = channels[k];
    if (!c) return null;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < c.h; y++)
      for (let x = 0; x < c.w; x++) {
        const dx = c.x - left + x;
        const dy = c.y - top + y;
        if (dx >= 0 && dy >= 0 && dx < w && dy < h) out[dy * w + dx] = c.values[y * c.w + x]!;
      }
    return out;
  };
  const planes = Array.from({ length: cc }, (_, k) => plane(k));
  // The first written array after the colour channels is the transparency.
  const alpha = plane(cc);
  if (mode === 4 || mode === 9) notes.add('CMYK and Lab patterns became RGB by a simple conversion.');
  for (let i = 0; i < w * h; i++) {
    const v = (k: number) => planes[k]?.[i] ?? 0;
    let rgb: [number, number, number];
    if (mode === 3) rgb = [v(0), v(1), v(2)];
    else if (mode === 1) rgb = [v(0), v(0), v(0)];
    else if (mode === 2) {
      const p = v(0) * 3;
      rgb = [palette![p]!, palette![p + 1]!, palette![p + 2]!];
    } else if (mode === 4) {
      // Stored as 255 − ink.
      const c = cmykToRgb(1 - v(0) / 255, 1 - v(1) / 255, 1 - v(2) / 255, 1 - v(3) / 255);
      rgb = [c.r, c.g, c.b].map((x) => Math.round(x * 255)) as [number, number, number];
    } else {
      const c = labToRgb({ L: (v(0) / 255) * 100, a: v(1) - 128, b: v(2) - 128 });
      rgb = [c.r, c.g, c.b].map((x) => Math.round(x * 255)) as [number, number, number];
    }
    data.set(rgb, i * 4);
    if (alpha) data[i * 4 + 3] = alpha[i]!;
  }
  return { id: '', name, width: w, height: h, data };
}

/** Reads a .pat file (pattern ids are left empty: the caller gives new ones). */
export function readPat(bytes: Uint8Array): PatImport {
  const r = new DescriptorReader(bytes);
  if (bytes.length < 10 || r.ascii(4) !== '8BPT') throw new Error('This is not a pattern file');
  const version = r.u16();
  if (version !== 1) throw new Error(`Pattern files of version ${version} cannot be read`);
  const count = r.u32();
  const notes = new Set<string>();
  const patterns: Pattern[] = [];
  for (let i = 0; i < count; i++) {
    const p = readPattern(r, notes, i);
    if (p) patterns.push(p);
  }
  if (patterns.length === 0) throw new Error([...notes][0] ?? 'The pattern file has no patterns');
  return { patterns, notes: [...notes] };
}

/** Writes patterns as a .pat file (RGB, with transparency where a pattern has any; uncompressed). */
export function writePat(patterns: readonly Pattern[]): Uint8Array {
  const w = new DescriptorWriter().ascii('8BPT').u16(1).u32(patterns.length);
  patterns.forEach((p) => {
    const n = p.width * p.height;
    let transparent = false;
    for (let i = 0; i < n; i++) if (p.data[i * 4 + 3] !== 255) transparent = true;
    const arrays = transparent ? 4 : 3;
    const channelBytes = 4 + 16 + 2 + 1 + n; // depth, rect, depth, compression, values
    const listLength = 16 + 4 + arrays * (8 + channelBytes) + (24 + 2 - arrays) * 4;
    w.u32(1).u32(3).u16(p.height).u16(p.width).unicode(p.name);
    const id = p.id.slice(0, 255);
    w.u8(id.length).ascii(id);
    w.u32(3).u32(listLength).u32(0).u32(0).u32(p.height).u32(p.width).u32(24);
    for (let k = 0; k < 24 + 2; k++) {
      if (k >= arrays) {
        w.u32(0);
        continue;
      }
      w.u32(1).u32(channelBytes).u32(8).u32(0).u32(0).u32(p.height).u32(p.width).u16(8).u8(0);
      const plane = new Uint8Array(n);
      for (let i = 0; i < n; i++) plane[i] = p.data[i * 4 + k]!;
      w.bytes(plane);
    }
  });
  return w.result();
}
