/**
 * Builds small .abr files (version 6.1) for tests: sampled tips and a descriptor of
 * brush presets, encoded as the format's binary descriptor (the public "descriptor
 * structure": class ids, OS types, unit doubles, lists).
 */

export type DescValue =
  | { t: 'Objc'; cls: string; items: [string, DescValue][] }
  | { t: 'VlLs'; items: DescValue[] }
  | { t: 'UntF'; units: '#Pxl' | '#Ang' | '#Prc'; value: number }
  | { t: 'bool'; value: boolean }
  | { t: 'long'; value: number }
  | { t: 'TEXT'; value: string }
  | { t: 'enum'; type: string; value: string };

class Writer {
  readonly bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v >> 8);
    this.u8(v);
  }
  u32(v: number) {
    this.u16((v >>> 16) & 0xffff);
    this.u16(v & 0xffff);
  }
  f64(v: number) {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, v);
    for (let i = 0; i < 8; i++) this.u8(b.getUint8(i));
  }
  ascii(s: string) {
    for (const c of s) this.u8(c.charCodeAt(0));
  }
  /** A key or class id: 4 characters as an id, otherwise a length-prefixed string. */
  id(s: string) {
    this.u32(s.length === 4 ? 0 : s.length);
    this.ascii(s);
  }
  unicode(s: string) {
    this.u32(s.length + 1);
    for (const c of s) this.u16(c.charCodeAt(0));
    this.u16(0);
  }
  value(v: DescValue) {
    switch (v.t) {
      case 'Objc':
        this.unicode('');
        this.id(v.cls);
        this.u32(v.items.length);
        for (const [key, item] of v.items) {
          this.id(key);
          this.ascii(item.t);
          this.value(item);
        }
        return;
      case 'VlLs':
        this.u32(v.items.length);
        for (const item of v.items) {
          this.ascii(item.t);
          this.value(item);
        }
        return;
      case 'UntF':
        this.ascii(v.units);
        this.f64(v.value);
        return;
      case 'bool':
        this.u8(v.value ? 1 : 0);
        return;
      case 'long':
        this.u32(v.value >>> 0);
        return;
      case 'TEXT':
        this.unicode(v.value);
        return;
      case 'enum':
        this.id(v.type);
        this.id(v.value);
        return;
    }
  }
}

export const px = (value: number): DescValue => ({ t: 'UntF', units: '#Pxl', value });
export const deg = (value: number): DescValue => ({ t: 'UntF', units: '#Ang', value });
export const pct = (value: number): DescValue => ({ t: 'UntF', units: '#Prc', value });
export const bool = (value: boolean): DescValue => ({ t: 'bool', value });
export const long = (value: number): DescValue => ({ t: 'long', value });
export const text = (value: string): DescValue => ({ t: 'TEXT', value });
export const obj = (cls: string, items: Record<string, DescValue>): DescValue => ({
  t: 'Objc',
  cls,
  items: Object.entries(items),
});
/** A dynamics block: control index (0 off, 1 fade, 2 pen pressure, 3 pen tilt…), fade steps, jitter %, minimum %. */
export const dyn = (control: number, jitter = 0, minimum = 0, steps = 25): DescValue =>
  obj('brVr', { bVTy: long(control), fStp: long(steps), jitter: pct(jitter), 'Mnm ': pct(minimum) });

export interface AbrSample {
  id: string;
  width: number;
  height: number;
  data: Uint8Array;
}

/** An .abr file (6.1) with these sampled tips and brush presets (descriptors of class 'Brsh' items). */
export function writeAbr(samples: AbrSample[], brushes: DescValue[]): Uint8Array {
  const w = new Writer();
  w.u16(6);
  w.u16(1);
  // Sampled tips.
  const samp = new Writer();
  for (const s of samples) {
    const body = new Writer();
    body.u8(s.id.length);
    body.ascii(s.id);
    for (let i = 0; i < 10; i++) body.u8(0); // the version 1 extras the reader skips
    body.u32(0); // top
    body.u32(0); // left
    body.u32(s.height); // bottom
    body.u32(s.width); // right
    body.u16(8); // depth
    body.u8(0); // raw
    for (const v of s.data) body.u8(v);
    samp.u32(body.bytes.length);
    samp.bytes.push(...body.bytes);
    while (samp.bytes.length % 4) samp.u8(0);
  }
  w.ascii('8BIMsamp');
  w.u32(samp.bytes.length);
  w.bytes.push(...samp.bytes);
  // The presets.
  const desc = new Writer();
  desc.u32(16);
  desc.value(obj('null', { Brsh: { t: 'VlLs', items: brushes } }));
  w.ascii('8BIMdesc');
  w.u32(desc.bytes.length);
  w.bytes.push(...desc.bytes);
  return Uint8Array.from(w.bytes);
}
