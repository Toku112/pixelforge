/**
 * Bytes as base64 text and back (binary data inside JSON: brush files, recorded paint).
 * Written out here because the core runs without browser APIs.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUES = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) VALUES[ALPHABET.charCodeAt(i)] = i;

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (a << 16) | (b << 8) | c;
    chunk +=
      ALPHABET[(n >> 18) & 63]! +
      ALPHABET[(n >> 12) & 63]! +
      (i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63]! : '=') +
      (i + 2 < bytes.length ? ALPHABET[n & 63]! : '=');
    if (chunk.length >= 0x4000) {
      parts.push(chunk);
      chunk = '';
    }
  }
  parts.push(chunk);
  return parts.join('');
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[\s=]+/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    let n = 0;
    let count = 0;
    for (let j = 0; j < 4; j++) {
      const ch = i + j < clean.length ? clean.charCodeAt(i + j) : -1;
      if (ch < 0) {
        n <<= 6;
        continue;
      }
      const v = ch < 128 ? VALUES[ch]! : -1;
      if (v < 0) throw new Error('Not base64 text');
      n = (n << 6) | v;
      count++;
    }
    if (count >= 2) out[o++] = (n >> 16) & 255;
    if (count >= 3) out[o++] = (n >> 8) & 255;
    if (count >= 4) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}
