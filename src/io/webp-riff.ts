/**
 * Adds an ICC profile to a WebP file made by the browser's encoder (which writes
 * none). The file becomes the extended format: a VP8X header with the ICC flag
 * (and the alpha flag when the image has alpha), then the ICCP chunk, then the
 * image chunks unchanged (WebP container specification, "Extended File Format").
 */

interface Chunk {
  fourcc: string;
  data: Uint8Array;
}

function readChunks(file: Uint8Array): Chunk[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const tag = (o: number) => String.fromCharCode(file[o]!, file[o + 1]!, file[o + 2]!, file[o + 3]!);
  if (file.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') throw new Error('Not a WebP file');
  const chunks: Chunk[] = [];
  for (let o = 12; o + 8 <= file.length;) {
    const size = view.getUint32(o + 4, true);
    chunks.push({ fourcc: tag(o), data: file.subarray(o + 8, o + 8 + size) });
    o += 8 + size + (size % 2); // chunks are padded to even sizes
  }
  return chunks;
}

function writeFile(chunks: Chunk[]): Uint8Array {
  const size = 4 + chunks.reduce((n, c) => n + 8 + c.data.length + (c.data.length % 2), 0);
  const out = new Uint8Array(8 + size);
  const view = new DataView(out.buffer);
  const tag = (o: number, s: string) =>
    out.set(
      [...s].map((ch) => ch.charCodeAt(0)),
      o,
    );
  tag(0, 'RIFF');
  view.setUint32(4, size, true);
  tag(8, 'WEBP');
  let o = 12;
  for (const c of chunks) {
    tag(o, c.fourcc);
    view.setUint32(o + 4, c.data.length, true);
    out.set(c.data, o + 8);
    o += 8 + c.data.length + (c.data.length % 2);
  }
  return out;
}

/** The file with `icc` embedded (replacing any profile it had). */
export function withIccProfile(file: Uint8Array, icc: Uint8Array, width: number, height: number): Uint8Array {
  const chunks = readChunks(file).filter((c) => c.fourcc !== 'ICCP');
  let vp8x = chunks.find((c) => c.fourcc === 'VP8X');
  if (!vp8x) {
    vp8x = { fourcc: 'VP8X', data: new Uint8Array(10) };
    const w = width - 1;
    const h = height - 1;
    vp8x.data.set([
      0,
      0,
      0,
      0,
      w & 0xff,
      (w >> 8) & 0xff,
      (w >> 16) & 0xff,
      h & 0xff,
      (h >> 8) & 0xff,
      (h >> 16) & 0xff,
    ]);
    // Alpha: a separate ALPH chunk, or a lossless (VP8L) bitstream that says it has alpha.
    const vp8l = chunks.find((c) => c.fourcc === 'VP8L');
    const hasAlpha = chunks.some((c) => c.fourcc === 'ALPH') || (!!vp8l && ((vp8l.data[4]! >> 4) & 1) === 1);
    if (hasAlpha) vp8x.data[0]! |= 0x10;
    chunks.unshift(vp8x);
  } else {
    vp8x.data = vp8x.data.slice();
  }
  vp8x.data[0]! |= 0x20; // ICC profile present
  const at = chunks.indexOf(vp8x) + 1;
  chunks.splice(at, 0, { fourcc: 'ICCP', data: icc });
  return writeFile(chunks);
}
