import { describe, expect, it } from 'vitest';
import { ImageDocument } from '../../../../src/core/document/document';
import { averageColor, sampleArea, samplePlan, sampleRect, sampledToRgb } from '../../../../src/core/paint/sample';
import { readAco, readAse } from '../../../../src/io/swatch-files';

/** Fills a rectangle of a layer with one RGBA colour. */
function fill(
  layer: { buffer: { writeRegion(r: { x: number; y: number; w: number; h: number }, src: Uint8Array): void } },
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: number[],
) {
  const src = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) src.set(rgba, i * 4);
  layer.buffer.writeRegion({ x, y, w, h }, src);
}

/** A document with a white Background, a red layer over its left half and a blue layer in a group. */
function scene() {
  const doc = new ImageDocument({ width: 40, height: 20 });
  const bg = doc.createBackgroundLayer();
  doc.insertLayer(bg);
  const red = doc.createPixelLayer('Red');
  doc.insertLayer(red);
  fill(red, 0, 0, 20, 20, [255, 0, 0, 255]);
  const group = doc.createGroup('Group');
  doc.insertLayer(group);
  const blue = doc.createPixelLayer('Blue');
  doc.insertLayer(blue, group.id);
  fill(blue, 10, 0, 20, 10, [0, 0, 255, 255]);
  return { doc, bg, red, blue };
}

describe('colour sampling', () => {
  it('samples a square around the point, clipped to the canvas', () => {
    const canvas = { x: 0, y: 0, w: 40, h: 20 };
    expect(sampleRect(10.7, 5.2, 1, canvas)).toEqual({ x: 10, y: 5, w: 1, h: 1 });
    expect(sampleRect(10, 5, 5, canvas)).toEqual({ x: 8, y: 3, w: 5, h: 5 });
    expect(sampleRect(0, 0, 5, canvas)).toEqual({ x: 0, y: 0, w: 3, h: 3 });
    expect(sampleRect(-10, 5, 3, canvas)).toBeNull();
  });

  it('samples all layers, the current one, or the current one and below', () => {
    const { doc, red, blue } = scene();
    const at = (x: number, y: number, size = 1) => {
      const v = sampleArea(samplePlan(doc, source), sampleRect(x, y, size, doc.canvasRect)!);
      return v && sampledToRgb(v, doc.mode, doc.depth);
    };
    let source: 'all' | 'current' | 'current-below' = 'all';
    expect(at(15, 5)).toEqual({ r: 0, g: 0, b: 1 }); // blue over red
    expect(at(15, 15)).toEqual({ r: 1, g: 0, b: 0 });
    expect(at(35, 15)).toEqual({ r: 1, g: 1, b: 1 });
    doc.setActiveLayer(red.id);
    source = 'current';
    expect(at(15, 5)).toEqual({ r: 1, g: 0, b: 0 }); // the blue above is left out
    expect(at(35, 15)).toBeNull(); // nothing painted on the red layer there
    source = 'current-below';
    expect(at(35, 15)).toEqual({ r: 1, g: 1, b: 1 }); // the Background below shows
    doc.setActiveLayer(blue.id);
    expect(at(15, 5)).toEqual({ r: 0, g: 0, b: 1 }); // into the group, up to the blue layer
    // An average: a 3 × 3 square across the red layer's edge (columns 19–21: 3 red, 6 white pixels).
    source = 'all';
    const mixed = at(20, 15, 3)!;
    expect(mixed.r).toBeCloseTo(1);
    expect(mixed.g).toBeCloseTo(2 / 3);
  });

  it('ignores transparent pixels when averaging, and converts gray and 32-bit values', () => {
    const composite = {
      rect: { x: 0, y: 0, w: 2, h: 1 },
      colorChannels: 3,
      data: Float32Array.of(0.5, 0, 0, 0.5, 0, 0, 0, 0),
    };
    const avg = averageColor(composite)!;
    expect(avg[0]).toBeCloseTo(1);
    expect(avg.slice(1)).toEqual([0, 0]);
    expect(averageColor({ ...composite, data: new Float32Array(8) })).toBeNull();
    expect(sampledToRgb([0.25], 'grayscale', 8)).toEqual({ r: 0.25, g: 0.25, b: 0.25 });
    const linear = sampledToRgb([0.214, 1.5, -1], 'rgb', 32);
    expect(linear.r).toBeCloseTo(0.5, 2);
    expect(linear.g).toBeCloseTo(1);
    expect(linear.b).toBe(0);
  });
});

/** Big-endian bytes helper for swatch files. */
class Bytes {
  readonly out: number[] = [];
  u16(v: number) {
    this.out.push((v >> 8) & 255, v & 255);
    return this;
  }
  u32(v: number) {
    return this.u16((v >>> 16) & 0xffff).u16(v & 0xffff);
  }
  f32(v: number) {
    const b = new DataView(new ArrayBuffer(4));
    b.setFloat32(0, v);
    for (let i = 0; i < 4; i++) this.out.push(b.getUint8(i));
    return this;
  }
  ascii(s: string) {
    for (const c of s) this.out.push(c.charCodeAt(0));
    return this;
  }
  utf16(s: string) {
    this.u16(s.length + 1);
    for (const c of s) this.u16(c.charCodeAt(0));
    return this.u16(0);
  }
  bytes() {
    return Uint8Array.from(this.out);
  }
}

describe('swatch files', () => {
  it('reads .ase groups and colours (RGB, CMYK, Gray), loose colours in their own group', () => {
    const entry = (name: string, model: string, values: number[]) => {
      const body = new Bytes().utf16(name).ascii(model);
      for (const v of values) body.f32(v);
      body.u16(2); // normal colour
      return [0x00, 0x01, ...new Bytes().u32(body.out.length).out, ...body.out];
    };
    const groupStart = (name: string) => {
      const body = new Bytes().utf16(name);
      return [0xc0, 0x01, ...new Bytes().u32(body.out.length).out, ...body.out];
    };
    const blocks = [
      groupStart('Brand'),
      entry('Signal', 'RGB ', [1, 0.5, 0]),
      entry('Ink', 'CMYK', [1, 0, 0, 0]),
      [0xc0, 0x02, 0, 0, 0, 0],
      entry('Mid', 'Gray', [0.5]),
    ];
    const file = new Bytes().ascii('ASEF').u16(1).u16(0).u32(blocks.length);
    for (const b of blocks) file.out.push(...b);
    const groups = readAse(file.bytes(), 'Imported');
    expect(groups.map((g) => [g.name, g.swatches.map((s) => s.name)])).toEqual([
      ['Brand', ['Signal', 'Ink']],
      ['Imported', ['Mid']],
    ]);
    expect(groups[0]!.swatches[0]!.color).toEqual({ r: 1, g: 0.5, b: 0 });
    expect(groups[0]!.swatches[1]!.color).toEqual({ r: 0, g: 1, b: 1 }); // cyan ink
    expect(() => readAse(new Bytes().ascii('NOPE').bytes(), 'X')).toThrow(/not a swatch exchange/);
  });

  it('reads .aco files, taking the names from the version 2 part', () => {
    const v1 = new Bytes().u16(1).u16(2).u16(0).u16(65535).u16(0).u16(0).u16(0).u16(8).u16(2500).u16(0).u16(0).u16(0);
    const v2 = new Bytes().u16(2).u16(2);
    v2.u16(0).u16(65535).u16(0).u16(0).u16(0).u32(4);
    for (const c of 'Red') v2.u16(c.charCodeAt(0));
    v2.u16(0);
    v2.u16(8).u16(2500).u16(0).u16(0).u16(0).u32(5);
    for (const c of 'Gray') v2.u16(c.charCodeAt(0));
    v2.u16(0);
    const [group] = readAco(Uint8Array.from([...v1.out, ...v2.out]), 'Old');
    expect(group!.name).toBe('Old');
    expect(group!.swatches.map((s) => s.name)).toEqual(['Red', 'Gray']);
    expect(group!.swatches[0]!.color).toEqual({ r: 1, g: 0, b: 0 });
    expect(group!.swatches[1]!.color.r).toBeCloseTo(0.75); // 25 % black
    expect(() => readAco(Uint8Array.of(0, 9, 0, 0), 'X')).toThrow(/not a colour swatch/);
  });
});
