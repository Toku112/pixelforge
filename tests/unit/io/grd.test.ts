import { describe, expect, it } from 'vitest';
import { defaultGradients, type NoiseGradient, type SolidGradient } from '../../../src/core/paint/gradient';
import { DescriptorReader, DescriptorWriter, desc, type DescValue, type Descriptor } from '../../../src/io/descriptor';
import { readGrd, writeGrd } from '../../../src/io/grd';

const obj = (classId: string, entries: [string, DescValue][]): DescValue => ({
  type: 'Objc',
  value: desc(classId, entries),
});
const long = (value: number): DescValue => ({ type: 'long', value });
const doub = (value: number): DescValue => ({ type: 'doub', value });

/** A .grd file around gradient descriptors (each list entry holding one under 'Grad'). */
function grdFile(gradients: DescValue[]): Uint8Array {
  const root = desc('null', [['GrdL', { type: 'VlLs', value: gradients.map((g) => obj('Grdn', [['Grad', g]])) }]]);
  return new DescriptorWriter().ascii('8BGR').u16(5).u32(16).descriptor(root).result();
}

const stop = (color: DescValue, location: number, type = 'UsrS', midpoint = 50) =>
  obj('Clrt', [
    ['Clr ', color],
    ['Type', { type: 'enum', enumType: 'Clry', value: type }],
    ['Lctn', long(location)],
    ['Mdpn', long(midpoint)],
  ]);

describe('action descriptors', () => {
  it('read back what was written, for every value type', () => {
    const d: Descriptor = desc('Tst ', [
      ['doub', doub(1.5)],
      ['long', long(-7)],
      ['text', { type: 'TEXT', value: 'Ünïcode' }],
      ['bool', { type: 'bool', value: true }],
      ['enum', { type: 'enum', enumType: 'GrdF', value: 'CstS' }],
      ['unit', { type: 'UntF', units: '#Prc', value: 42 }],
      ['ufl ', { type: 'UnFl', units: '#Pxl', values: [1, 2] }],
      ['list', { type: 'VlLs', value: [long(1), { type: 'TEXT', value: 'x' }] }],
      ['comp', { type: 'comp', value: 2 ** 40 + 5 }],
      ['type', { type: 'type', name: '', classId: 'Lyr ' }],
      ['tdta', { type: 'tdta', bytes: Uint8Array.of(1, 2, 3) }],
      [
        'obj ',
        {
          type: 'obj ',
          parts: [
            { form: 'Enmr', classId: 'Lyr ', type: 'Ordn', value: 'Trgt' },
            { form: 'indx', value: 3 },
          ],
        },
      ],
      ['longKeyName', obj('nested', [['a   ', doub(2)]])],
    ]);
    const bytes = new DescriptorWriter().descriptor(d).result();
    const back = new DescriptorReader(bytes).descriptor();
    expect(back).toEqual(d);
    expect(() => new DescriptorReader(bytes.slice(0, bytes.length - 3)).descriptor()).toThrow(/ends too early/);
  });
});

describe('gradient files (.grd)', () => {
  it('read solid gradients in every colour model, with foreground/background and opacity stops', () => {
    const file = grdFile([
      obj('Grdn', [
        ['Nm  ', { type: 'TEXT', value: '$$$/DefaultGradient/Example=Shown Name' }],
        ['GrdF', { type: 'enum', enumType: 'GrdF', value: 'CstS' }],
        ['Intr', doub(2048)],
        [
          'Clrs',
          {
            type: 'VlLs',
            value: [
              stop(
                obj('RGBC', [
                  ['Rd  ', doub(255)],
                  ['Grn ', doub(127.5)],
                  ['Bl  ', doub(0)],
                ]),
                0,
                'FrgC',
                25,
              ),
              stop(
                obj('HSBC', [
                  ['H   ', { type: 'UntF', units: '#Ang', value: 120 }],
                  ['Strt', doub(100)],
                  ['Brgh', doub(100)],
                ]),
                1024,
              ),
              stop(
                obj('CMYC', [
                  ['Cyn ', doub(100)],
                  ['Mgnt', doub(0)],
                  ['Ylw ', doub(0)],
                  ['Blck', doub(0)],
                ]),
                2048,
              ),
              stop(obj('Grsc', [['Gry ', doub(25)]]), 3072),
              stop(
                obj('LbCl', [
                  ['Lmnc', doub(100)],
                  ['A   ', doub(0)],
                  ['B   ', doub(0)],
                ]),
                4096,
                'BckC',
              ),
            ],
          },
        ],
        [
          'Trns',
          {
            type: 'VlLs',
            value: [
              obj('TrnS', [
                ['Opct', { type: 'UntF', units: '#Prc', value: 100 }],
                ['Lctn', long(0)],
                ['Mdpn', long(50)],
              ]),
              obj('TrnS', [
                ['Opct', { type: 'UntF', units: '#Prc', value: 0 }],
                ['Lctn', long(4096)],
                ['Mdpn', long(50)],
              ]),
            ],
          },
        ],
      ]),
    ]);
    const { gradients, notes } = readGrd(file);
    expect(notes).toEqual([]);
    const g = gradients[0] as SolidGradient;
    expect(g.name).toBe('Shown Name');
    expect(g.smoothness).toBe(0.5);
    expect(g.colorStops.map((s) => [s.location, s.kind])).toEqual([
      [0, 'foreground'],
      [0.25, 'color'],
      [0.5, 'color'],
      [0.75, 'color'],
      [1, 'background'],
    ]);
    expect(g.colorStops[0]!.midpoint).toBe(0.25);
    expect(g.colorStops[0]!.color).toEqual({ r: 1, g: 0.5, b: 0 });
    expect(g.colorStops[1]!.color).toEqual({ r: 0, g: 1, b: 0 });
    expect(g.colorStops[2]!.color).toEqual({ r: 0, g: 1, b: 1 });
    expect(g.colorStops[3]!.color.r).toBeCloseTo(0.75);
    expect(g.colorStops[4]!.color.r).toBeCloseTo(1, 2);
    expect(g.opacityStops.map((s) => s.opacity)).toEqual([1, 0]);
  });

  it('read noise gradients, noting that their pattern is ours', () => {
    const file = grdFile([
      obj('Grdn', [
        ['Nm  ', { type: 'TEXT', value: 'Static' }],
        ['GrdF', { type: 'enum', enumType: 'GrdF', value: 'ClNs' }],
        ['ShTr', { type: 'bool', value: true }],
        ['VctC', { type: 'bool', value: false }],
        ['ClrS', { type: 'enum', enumType: 'ClrS', value: 'HSBl' }],
        ['RndS', long(12345)],
        ['Smth', long(1024)],
        ['Mnm ', { type: 'VlLs', value: [long(0), long(10), long(20), long(0)] }],
        ['Mxm ', { type: 'VlLs', value: [long(100), long(90), long(80), long(100)] }],
      ]),
    ]);
    const { gradients, notes } = readGrd(file);
    expect(gradients[0]).toEqual({
      type: 'noise',
      name: 'Static',
      roughness: 0.25,
      model: 'hsb',
      min: [0, 0.1, 0.2],
      max: [1, 0.9, 0.8],
      restrictColors: false,
      addTransparency: true,
      seed: 12345,
    } satisfies NoiseGradient);
    expect(notes).toHaveLength(1);
  });

  it('round-trip our gradients through a file; refuse other files clearly', () => {
    const ours = defaultGradients().flatMap((g) => g.gradients.map((e) => e.gradient));
    const back = readGrd(writeGrd(ours)).gradients;
    expect(back.map((g) => g.name)).toEqual(ours.map((g) => g.name));
    back.forEach((g, i) => {
      const o = ours[i] as SolidGradient;
      const b = g as SolidGradient;
      expect(b.colorStops.map((s) => s.kind)).toEqual(o.colorStops.map((s) => s.kind));
      b.colorStops.forEach((s, j) => {
        expect(s.location).toBeCloseTo(o.colorStops[j]!.location, 3);
        expect(s.color.g).toBeCloseTo(o.colorStops[j]!.color.g, 6);
      });
      expect(b.opacityStops.map((s) => s.opacity)).toEqual(o.opacityStops.map((s) => s.opacity));
    });
    expect(() => readGrd(new TextEncoder().encode('8BPS....'))).toThrow(/not a gradient file/);
    expect(() => readGrd(Uint8Array.of(56, 66, 71, 82, 0, 3))).toThrow(/version 3/);
  });
});
