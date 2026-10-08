/**
 * Gradient files of the reference app (.grd, version 5 — the format of its 2000
 * release on): a list of gradients in an action descriptor (see descriptor.ts). We
 * read solid gradients (colour stops in RGB, HSB, CMYK, Lab or gray; foreground and
 * background stops; opacity stops; smoothness) and noise gradients, and write our
 * gradients in the same format (Export Selected Gradients).
 *
 * Colours become sRGB like swatch files (swatch-files.ts). Noise gradients keep their
 * settings but get our own random pattern for them. Version 3 files (from before
 * 2000) are not read.
 */
import { hsbToRgb, labToRgb, type RGB } from '../core/color/color';
import type { ColorStop, Gradient, NoiseModel, OpacityStop } from '../core/paint/gradient';
import {
  DescriptorReader,
  DescriptorWriter,
  desc,
  descBool,
  descEnum,
  descList,
  descNumber,
  descObject,
  descString,
  type DescValue,
  type Descriptor,
} from './descriptor';
import { cmykToRgb } from './swatch-files';

export interface GrdImport {
  gradients: Gradient[];
  /** What was approximated, for the user. */
  notes: string[];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Locations are 0–4096 in the file. */
const LOCATION_SCALE = 4096;

/** "$$$/Key/Name=Shown Name" (a localisable name) → "Shown Name". */
function displayName(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (raw.startsWith('$$$/')) {
    const eq = raw.indexOf('=');
    return eq >= 0 ? raw.slice(eq + 1) : fallback;
  }
  return raw;
}

function readColor(d: Descriptor | undefined, notes: Set<string>): RGB {
  if (!d) return { r: 0, g: 0, b: 0 };
  const n = (key: string) => descNumber(d, key) ?? 0;
  switch (d.classId) {
    case 'RGBC':
      if (d.items.has('redFloat'))
        return { r: clamp01(n('redFloat')), g: clamp01(n('greenFloat')), b: clamp01(n('blueFloat')) };
      return { r: clamp01(n('Rd  ') / 255), g: clamp01(n('Grn ') / 255), b: clamp01(n('Bl  ') / 255) };
    case 'HSBC':
      return hsbToRgb({ h: n('H   '), s: clamp01(n('Strt') / 100), b: clamp01(n('Brgh') / 100) });
    case 'CMYC':
      return cmykToRgb(n('Cyn ') / 100, n('Mgnt') / 100, n('Ylw ') / 100, n('Blck') / 100);
    case 'LbCl':
      return labToRgb({ L: n('Lmnc'), a: n('A   '), b: n('B   ') });
    case 'Grsc': {
      const v = clamp01(1 - n('Gry ') / 100);
      return { r: v, g: v, b: v };
    }
    default:
      notes.add('Colours from colour books have no colour values in the file; they became gray.');
      return { r: 0.5, g: 0.5, b: 0.5 };
  }
}

function readGradient(d: Descriptor, notes: Set<string>): Gradient {
  const name = displayName(descString(d, 'Nm  '), 'Gradient');
  if (descEnum(d, 'GrdF') === 'ClNs') {
    notes.add('Noise gradients keep their settings but get our own random pattern for them.');
    const space = descEnum(d, 'ClrS');
    const model: NoiseModel = space === 'LbCl' ? 'lab' : space === 'HSBl' || space === 'HSLC' ? 'hsb' : 'rgb';
    const range = (key: string, fallback: number) => {
      const values = descList(d, key).map((v) => (v.type === 'long' || v.type === 'doub' ? v.value : fallback * 100));
      return [0, 1, 2].map((i) => clamp01((values[i] ?? fallback * 100) / 100)) as [number, number, number];
    };
    return {
      type: 'noise',
      name,
      roughness: clamp01((descNumber(d, 'Smth') ?? 2048) / LOCATION_SCALE),
      model,
      min: range('Mnm ', 0),
      max: range('Mxm ', 1),
      restrictColors: descBool(d, 'VctC') ?? false,
      addTransparency: descBool(d, 'ShTr') ?? false,
      seed: Math.abs(Math.round(descNumber(d, 'RndS') ?? 1)) % 2 ** 31,
    };
  }
  const objects = (key: string) =>
    descList(d, key).flatMap((v) => (v.type === 'Objc' || v.type === 'GlbO' ? [v.value] : []));
  const location = (s: Descriptor) => clamp01((descNumber(s, 'Lctn') ?? 0) / LOCATION_SCALE);
  const midpoint = (s: Descriptor) => Math.min(0.95, Math.max(0.05, (descNumber(s, 'Mdpn') ?? 50) / 100));
  const colorStops = objects('Clrs').map((s): ColorStop => {
    const type = descEnum(s, 'Type');
    return {
      location: location(s),
      midpoint: midpoint(s),
      color: readColor(descObject(s, 'Clr '), notes),
      kind: type === 'FrgC' ? 'foreground' : type === 'BckC' ? 'background' : 'color',
    };
  });
  const opacityStops = objects('Trns').map((s): OpacityStop => ({
    location: location(s),
    midpoint: midpoint(s),
    opacity: clamp01((descNumber(s, 'Opct') ?? 100) / 100),
  }));
  if (colorStops.length === 0)
    colorStops.push({ location: 0, midpoint: 0.5, color: { r: 0, g: 0, b: 0 }, kind: 'color' });
  return {
    type: 'solid',
    name,
    colorStops,
    opacityStops:
      opacityStops.length > 0
        ? opacityStops
        : [
            { location: 0, midpoint: 0.5, opacity: 1 },
            { location: 1, midpoint: 0.5, opacity: 1 },
          ],
    smoothness: clamp01((descNumber(d, 'Intr') ?? LOCATION_SCALE) / LOCATION_SCALE),
  };
}

/** Reads a .grd file. */
export function readGrd(bytes: Uint8Array): GrdImport {
  const r = new DescriptorReader(bytes);
  if (bytes.length < 6 || r.ascii(4) !== '8BGR') throw new Error('This is not a gradient file');
  const version = r.u16();
  if (version === 3)
    throw new Error('This gradient file uses the version 3 format (from before 2000), which cannot be read');
  if (version !== 5) throw new Error(`Gradient files of version ${version} cannot be read`);
  if (r.u32() !== 16) throw new Error('The gradient file is damaged');
  const root = r.descriptor();
  const notes = new Set<string>();
  const gradients: Gradient[] = [];
  for (const item of descList(root, 'GrdL')) {
    if (item.type !== 'Objc' && item.type !== 'GlbO') continue;
    // Each entry holds the gradient under 'Grad' (or is the gradient itself).
    const g = descObject(item.value, 'Grad') ?? item.value;
    gradients.push(readGradient(g, notes));
  }
  if (gradients.length === 0) throw new Error('The gradient file has no gradients');
  return { gradients, notes: [...notes] };
}

const long = (value: number): DescValue => ({ type: 'long', value: Math.round(value) });
const obj = (classId: string, entries: [string, DescValue][]): DescValue => ({
  type: 'Objc',
  value: desc(classId, entries),
});

function gradientDescriptor(g: Gradient): DescValue {
  if (g.type === 'noise') {
    const space = g.model === 'lab' ? 'LbCl' : g.model === 'hsb' ? 'HSBl' : 'RGBC';
    return obj('Grdn', [
      ['Nm  ', { type: 'TEXT', value: g.name }],
      ['GrdF', { type: 'enum', enumType: 'GrdF', value: 'ClNs' }],
      ['ShTr', { type: 'bool', value: g.addTransparency }],
      ['VctC', { type: 'bool', value: g.restrictColors }],
      ['ClrS', { type: 'enum', enumType: 'ClrS', value: space }],
      ['RndS', long(g.seed)],
      ['Smth', long(g.roughness * LOCATION_SCALE)],
      ['Mnm ', { type: 'VlLs', value: [...g.min.map((v) => long(v * 100)), long(0)] }],
      ['Mxm ', { type: 'VlLs', value: [...g.max.map((v) => long(v * 100)), long(100)] }],
    ]);
  }
  return obj('Grdn', [
    ['Nm  ', { type: 'TEXT', value: g.name }],
    ['GrdF', { type: 'enum', enumType: 'GrdF', value: 'CstS' }],
    ['Intr', { type: 'doub', value: Math.round(g.smoothness * LOCATION_SCALE) }],
    [
      'Clrs',
      {
        type: 'VlLs',
        value: g.colorStops.map((s) =>
          obj('Clrt', [
            [
              'Clr ',
              obj('RGBC', [
                ['Rd  ', { type: 'doub', value: s.color.r * 255 }],
                ['Grn ', { type: 'doub', value: s.color.g * 255 }],
                ['Bl  ', { type: 'doub', value: s.color.b * 255 }],
              ]),
            ],
            [
              'Type',
              {
                type: 'enum',
                enumType: 'Clry',
                value: s.kind === 'foreground' ? 'FrgC' : s.kind === 'background' ? 'BckC' : 'UsrS',
              },
            ],
            ['Lctn', long(s.location * LOCATION_SCALE)],
            ['Mdpn', long(s.midpoint * 100)],
          ]),
        ),
      },
    ],
    [
      'Trns',
      {
        type: 'VlLs',
        value: g.opacityStops.map((s) =>
          obj('TrnS', [
            ['Opct', { type: 'UntF', units: '#Prc', value: s.opacity * 100 }],
            ['Lctn', long(s.location * LOCATION_SCALE)],
            ['Mdpn', long(s.midpoint * 100)],
          ]),
        ),
      },
    ],
  ]);
}

/** Writes gradients as a .grd file (version 5). */
export function writeGrd(gradients: readonly Gradient[]): Uint8Array {
  const root = desc('null', [
    [
      'GrdL',
      {
        type: 'VlLs',
        value: gradients.map((g) => obj('Grdn', [['Grad', gradientDescriptor(g)]])),
      },
    ],
  ]);
  return new DescriptorWriter().ascii('8BGR').u16(5).u32(16).descriptor(root).result();
}
