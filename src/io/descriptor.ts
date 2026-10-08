/**
 * Action descriptors: the reference app's self-describing key/value structure used
 * in its preset files (gradients, styles, tool presets), actions and many PSD
 * sections. Big-endian. Read and written here from the public file format
 * description, in our own code (FORMAT_NOTES §11).
 *
 * A descriptor is: a name (Unicode string), a class ID, a count, then per item a key
 * ID, a four-letter type and the value. IDs are a 32-bit length followed by that many
 * ASCII characters, or a length of 0 followed by a four-character code.
 */

export interface Descriptor {
  name: string;
  classId: string;
  items: Map<string, DescValue>;
}

/** One reference part ('obj ' values): what a property, class, enumerated value etc. points at. */
export type ReferencePart =
  | { form: 'prop'; classId: string; key: string }
  | { form: 'Clss'; classId: string }
  | { form: 'Enmr'; classId: string; type: string; value: string }
  | { form: 'rele'; classId: string; offset: number }
  | { form: 'Idnt' | 'indx'; value: number }
  | { form: 'name'; classId: string; value: string };

export type DescValue =
  | { type: 'Objc' | 'GlbO'; value: Descriptor }
  | { type: 'VlLs'; value: DescValue[] }
  | { type: 'doub'; value: number }
  | { type: 'UntF'; units: string; value: number }
  | { type: 'UnFl'; units: string; values: number[] }
  | { type: 'TEXT'; value: string }
  | { type: 'enum'; enumType: string; value: string }
  | { type: 'long'; value: number }
  | { type: 'comp'; value: number }
  | { type: 'bool'; value: boolean }
  | { type: 'type' | 'GlbC'; name: string; classId: string }
  | { type: 'alis' | 'tdta' | 'Pth '; bytes: Uint8Array }
  | { type: 'obj '; parts: ReferencePart[] };

export class DescriptorReader {
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  offset: number;

  constructor(bytes: Uint8Array, offset = 0) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }

  get left(): number {
    return this.#view.byteLength - this.offset;
  }

  #need(n: number): void {
    if (n < 0 || this.left < n) throw new Error('The file ends too early');
  }

  u8(): number {
    this.#need(1);
    return this.#view.getUint8(this.offset++);
  }

  u16(): number {
    this.#need(2);
    const v = this.#view.getUint16(this.offset);
    this.offset += 2;
    return v;
  }

  u32(): number {
    this.#need(4);
    const v = this.#view.getUint32(this.offset);
    this.offset += 4;
    return v;
  }

  i32(): number {
    this.#need(4);
    const v = this.#view.getInt32(this.offset);
    this.offset += 4;
    return v;
  }

  f64(): number {
    this.#need(8);
    const v = this.#view.getFloat64(this.offset);
    this.offset += 8;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.#need(n);
    const out = this.#bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  ascii(n: number): string {
    this.#need(n);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.#view.getUint8(this.offset + i));
    this.offset += n;
    return s;
  }

  /** A Unicode string: a count of UTF-16 code units, then the units (a trailing NUL dropped). */
  unicode(): string {
    const count = this.u32();
    this.#need(count * 2);
    let s = '';
    for (let i = 0; i < count; i++) s += String.fromCharCode(this.u16());
    return s.endsWith('\0') ? s.slice(0, -1) : s;
  }

  /** A class, key or enumeration ID. */
  id(): string {
    const n = this.u32();
    return this.ascii(n === 0 ? 4 : n);
  }

  descriptor(): Descriptor {
    const name = this.unicode();
    const classId = this.id();
    const count = this.u32();
    const items = new Map<string, DescValue>();
    for (let i = 0; i < count; i++) {
      const key = this.id();
      items.set(key, this.value(this.ascii(4)));
    }
    return { name, classId, items };
  }

  value(type: string): DescValue {
    switch (type) {
      case 'Objc':
      case 'GlbO':
        return { type, value: this.descriptor() };
      case 'VlLs': {
        const count = this.u32();
        const value: DescValue[] = [];
        for (let i = 0; i < count; i++) value.push(this.value(this.ascii(4)));
        return { type, value };
      }
      case 'doub':
        return { type, value: this.f64() };
      case 'UntF':
        return { type, units: this.ascii(4), value: this.f64() };
      case 'UnFl': {
        const units = this.ascii(4);
        const count = this.u32();
        return { type, units, values: Array.from({ length: count }, () => this.f64()) };
      }
      case 'TEXT':
        return { type, value: this.unicode() };
      case 'enum':
        return { type, enumType: this.id(), value: this.id() };
      case 'long':
        return { type, value: this.i32() };
      case 'comp': {
        const hi = this.i32();
        const lo = this.u32();
        return { type, value: hi * 2 ** 32 + lo };
      }
      case 'bool':
        return { type, value: this.u8() !== 0 };
      case 'type':
      case 'GlbC':
        return { type, name: this.unicode(), classId: this.id() };
      case 'alis':
      case 'tdta':
      case 'Pth ':
        return { type, bytes: this.bytes(this.u32()) };
      case 'obj ': {
        const count = this.u32();
        const parts: ReferencePart[] = [];
        for (let i = 0; i < count; i++) parts.push(this.#referencePart());
        return { type, parts };
      }
      default:
        throw new Error(`Unknown descriptor value type "${type}"`);
    }
  }

  #referencePart(): ReferencePart {
    const form = this.ascii(4);
    switch (form) {
      case 'prop': {
        this.unicode();
        return { form, classId: this.id(), key: this.id() };
      }
      case 'Clss':
        this.unicode();
        return { form, classId: this.id() };
      case 'Enmr': {
        this.unicode();
        const classId = this.id();
        return { form, classId, type: this.id(), value: this.id() };
      }
      case 'rele': {
        this.unicode();
        return { form, classId: this.id(), offset: this.i32() };
      }
      case 'Idnt':
      case 'indx':
        return { form, value: this.u32() };
      case 'name': {
        this.unicode();
        return { form, classId: this.id(), value: this.unicode() };
      }
      default:
        throw new Error(`Unknown descriptor reference form "${form}"`);
    }
  }
}

/** Writes descriptors (and the plain values around them in files). */
export class DescriptorWriter {
  readonly #out: number[] = [];

  u8(v: number): this {
    this.#out.push(v & 255);
    return this;
  }

  u16(v: number): this {
    this.#out.push((v >> 8) & 255, v & 255);
    return this;
  }

  u32(v: number): this {
    return this.u16((v >>> 16) & 0xffff).u16(v & 0xffff);
  }

  f64(v: number): this {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, v);
    for (let i = 0; i < 8; i++) this.#out.push(b.getUint8(i));
    return this;
  }

  ascii(s: string): this {
    for (const c of s) this.#out.push(c.charCodeAt(0) & 255);
    return this;
  }

  bytes(b: Uint8Array): this {
    for (const v of b) this.#out.push(v);
    return this;
  }

  unicode(s: string): this {
    this.u32(s.length + 1);
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    return this.u16(0);
  }

  id(s: string): this {
    if (s.length === 4) return this.u32(0).ascii(s);
    return this.u32(s.length).ascii(s);
  }

  descriptor(d: Descriptor): this {
    this.unicode(d.name).id(d.classId).u32(d.items.size);
    for (const [key, value] of d.items) this.id(key).value(value);
    return this;
  }

  value(v: DescValue): this {
    this.ascii(v.type);
    switch (v.type) {
      case 'Objc':
      case 'GlbO':
        return this.descriptor(v.value);
      case 'VlLs':
        this.u32(v.value.length);
        for (const item of v.value) this.value(item);
        return this;
      case 'doub':
        return this.f64(v.value);
      case 'UntF':
        return this.ascii(v.units).f64(v.value);
      case 'UnFl':
        this.ascii(v.units).u32(v.values.length);
        for (const x of v.values) this.f64(x);
        return this;
      case 'TEXT':
        return this.unicode(v.value);
      case 'enum':
        return this.id(v.enumType).id(v.value);
      case 'long':
        return this.u32(v.value >>> 0);
      case 'comp':
        return this.u32(Math.floor(v.value / 2 ** 32) >>> 0).u32(v.value >>> 0);
      case 'bool':
        return this.u8(v.value ? 1 : 0);
      case 'type':
      case 'GlbC':
        return this.unicode(v.name).id(v.classId);
      case 'alis':
      case 'tdta':
      case 'Pth ':
        return this.u32(v.bytes.length).bytes(v.bytes);
      case 'obj ':
        this.u32(v.parts.length);
        for (const p of v.parts) {
          this.ascii(p.form);
          switch (p.form) {
            case 'prop':
              this.unicode('').id(p.classId).id(p.key);
              break;
            case 'Clss':
              this.unicode('').id(p.classId);
              break;
            case 'Enmr':
              this.unicode('').id(p.classId).id(p.type).id(p.value);
              break;
            case 'rele':
              this.unicode('')
                .id(p.classId)
                .u32(p.offset >>> 0);
              break;
            case 'Idnt':
            case 'indx':
              this.u32(p.value);
              break;
            case 'name':
              this.unicode('').id(p.classId).unicode(p.value);
              break;
          }
        }
        return this;
    }
  }

  result(): Uint8Array {
    return Uint8Array.from(this.#out);
  }
}

/** A descriptor built from entries (for writing). */
export function desc(classId: string, entries: [string, DescValue][], name = ''): Descriptor {
  return { name, classId, items: new Map(entries) };
}

// Typed access to read descriptors (undefined when missing or of another type).

export function descNumber(d: Descriptor, key: string): number | undefined {
  const v = d.items.get(key);
  return v?.type === 'doub' || v?.type === 'long' || v?.type === 'UntF' || v?.type === 'comp' ? v.value : undefined;
}

export function descString(d: Descriptor, key: string): string | undefined {
  const v = d.items.get(key);
  return v?.type === 'TEXT' ? v.value : undefined;
}

export function descBool(d: Descriptor, key: string): boolean | undefined {
  const v = d.items.get(key);
  return v?.type === 'bool' ? v.value : undefined;
}

export function descEnum(d: Descriptor, key: string): string | undefined {
  const v = d.items.get(key);
  return v?.type === 'enum' ? v.value : undefined;
}

export function descObject(d: Descriptor, key: string): Descriptor | undefined {
  const v = d.items.get(key);
  return v?.type === 'Objc' || v?.type === 'GlbO' ? v.value : undefined;
}

export function descList(d: Descriptor, key: string): DescValue[] {
  const v = d.items.get(key);
  return v?.type === 'VlLs' ? v.value : [];
}
