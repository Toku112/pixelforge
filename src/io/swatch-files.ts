/**
 * Swatch files the user owns: swatch exchange files (.ase) and the reference app's
 * colour swatch files (.aco). Colours become sRGB (our documents are RGB or
 * Grayscale): CMYK by the simple uncalibrated formula, Lab through D65 sRGB, HSB and
 * gray directly. Colour management (Phase 7) will convert CMYK properly.
 */
import { hsbToRgb, labToRgb, type RGB } from '../core/color/color';
import type { SwatchGroup } from '../core/color/swatches';

class Reader {
  readonly #view: DataView;
  offset = 0;
  constructor(bytes: Uint8Array) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get left(): number {
    return this.#view.byteLength - this.offset;
  }
  #need(n: number) {
    if (this.left < n) throw new Error('The swatch file ends too early');
  }
  u16(): number {
    this.#need(2);
    const v = this.#view.getUint16(this.offset);
    this.offset += 2;
    return v;
  }
  i16(): number {
    this.#need(2);
    const v = this.#view.getInt16(this.offset);
    this.offset += 2;
    return v;
  }
  u32(): number {
    this.#need(4);
    const v = this.#view.getUint32(this.offset);
    this.offset += 4;
    return v;
  }
  f32(): number {
    this.#need(4);
    const v = this.#view.getFloat32(this.offset);
    this.offset += 4;
    return v;
  }
  ascii(n: number): string {
    this.#need(n);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.#view.getUint8(this.offset + i));
    this.offset += n;
    return s;
  }
  /** `count` UTF-16 code units, the trailing NUL dropped. */
  utf16(count: number): string {
    let s = '';
    for (let i = 0; i < count; i++) {
      const c = this.u16();
      if (c !== 0) s += String.fromCharCode(c);
    }
    return s;
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const cmykToRgb = (c: number, m: number, y: number, k: number): RGB => ({
  r: clamp01((1 - c) * (1 - k)),
  g: clamp01((1 - m) * (1 - k)),
  b: clamp01((1 - y) * (1 - k)),
});

let nextId = 0;
const swatchId = () => `sw-${Date.now().toString(36)}-${(nextId++).toString(36)}`;

/** A swatch exchange (.ase) file: groups of named colours (colours outside groups go into `fallbackGroup`). */
export function readAse(bytes: Uint8Array, fallbackGroup: string): SwatchGroup[] {
  const r = new Reader(bytes);
  if (r.left < 12 || r.ascii(4) !== 'ASEF') throw new Error('This is not a swatch exchange (.ase) file');
  r.u16(); // version major
  r.u16(); // version minor
  const blocks = r.u32();
  const groups: SwatchGroup[] = [];
  const loose: SwatchGroup = { name: fallbackGroup, swatches: [] };
  let current: SwatchGroup | null = null;
  for (let b = 0; b < blocks && r.left > 0; b++) {
    const type = r.u16();
    const length = r.u32();
    const end = r.offset + length;
    if (type === 0xc001) {
      current = { name: r.utf16(r.u16()) || fallbackGroup, swatches: [] };
      groups.push(current);
    } else if (type === 0xc002) {
      current = null;
    } else if (type === 0x0001) {
      const name = r.utf16(r.u16());
      const model = r.ascii(4);
      let color: RGB;
      if (model === 'RGB ') color = { r: clamp01(r.f32()), g: clamp01(r.f32()), b: clamp01(r.f32()) };
      else if (model === 'CMYK') color = cmykToRgb(r.f32(), r.f32(), r.f32(), r.f32());
      else if (model === 'LAB ') color = labToRgb({ L: r.f32() * 100, a: r.f32(), b: r.f32() });
      else if (model === 'Gray') {
        const g = clamp01(r.f32());
        color = { r: g, g, b: g };
      } else throw new Error(`This swatch file uses an unknown colour model (${model.trim()})`);
      (current ?? loose).swatches.push({ id: swatchId(), name: name || 'Swatch', color });
    }
    r.offset = end;
  }
  return [...groups.filter((g) => g.swatches.length > 0), ...(loose.swatches.length > 0 ? [loose] : [])];
}

/** The reference app's .aco file (version 1, and version 2 with names when present). */
export function readAco(bytes: Uint8Array, group: string): SwatchGroup[] {
  const r = new Reader(bytes);
  if (r.left < 4) throw new Error('This is not a colour swatch (.aco) file');
  const read = (version: number) => {
    const count = r.u16();
    const out: { name: string; color: RGB }[] = [];
    for (let i = 0; i < count; i++) {
      const space = r.u16();
      const w = r.u16();
      const x = r.u16();
      const y = r.u16();
      const z = r.u16();
      let name = '';
      if (version === 2) name = r.utf16(r.u32());
      let color: RGB | null = null;
      if (space === 0) color = { r: w / 65535, g: x / 65535, b: y / 65535 };
      else if (space === 1) color = hsbToRgb({ h: (w / 65535) * 360, s: x / 65535, b: y / 65535 });
      else if (space === 2) color = cmykToRgb(1 - w / 65535, 1 - x / 65535, 1 - y / 65535, 1 - z / 65535);
      else if (space === 7) {
        const asSigned = (v: number) => (v > 32767 ? v - 65536 : v);
        color = labToRgb({ L: w / 100, a: asSigned(x) / 100, b: asSigned(y) / 100 });
      } else if (space === 8) {
        const g = 1 - w / 10000;
        color = { r: g, g, b: g };
      }
      // Other colour spaces (custom inks) cannot be shown: skipped.
      if (color) out.push({ name, color });
    }
    return out;
  };
  const version = r.u16();
  if (version !== 1 && version !== 2) throw new Error('This is not a colour swatch (.aco) file');
  let colors = read(version);
  // Version 1 is usually followed by the same colours again with names (version 2).
  if (version === 1 && r.left >= 4) {
    const at = r.offset;
    if (r.u16() === 2) {
      try {
        colors = read(2);
      } catch {
        r.offset = at;
      }
    }
  }
  return [
    {
      name: group,
      swatches: colors.map((c, i) => ({ id: swatchId(), name: c.name || `Swatch ${i + 1}`, color: c.color })),
    },
  ];
}
