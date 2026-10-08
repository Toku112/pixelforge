/**
 * Swatches (the Swatches panel): named colours in groups. Our default set is ours
 * (CLAUDE.md §1.1: no licensed colour libraries); users import their own .ase/.aco files.
 */
import type { RGB } from './color';

export interface Swatch {
  id: string;
  name: string;
  color: RGB;
}

export interface SwatchGroup {
  name: string;
  swatches: Swatch[];
}

const hex = (h: string): RGB => ({
  r: parseInt(h.slice(0, 2), 16) / 255,
  g: parseInt(h.slice(2, 4), 16) / 255,
  b: parseInt(h.slice(4, 6), 16) / 255,
});

function group(name: string, prefix: string, colors: [string, string][]): SwatchGroup {
  return { name, swatches: colors.map(([n, h], i) => ({ id: `pf-${prefix}-${i}`, name: n, color: hex(h) })) };
}

export function defaultSwatches(): SwatchGroup[] {
  return [
    group('Basics', 'basic', [
      ['Black', '000000'],
      ['White', 'ffffff'],
      ['Red', 'ff0000'],
      ['Orange', 'ff8000'],
      ['Yellow', 'ffff00'],
      ['Lime', '80ff00'],
      ['Green', '00ff00'],
      ['Cyan', '00ffff'],
      ['Blue', '0000ff'],
      ['Violet', '8000ff'],
      ['Magenta', 'ff00ff'],
      ['Rose', 'ff0080'],
    ]),
    group(
      'Grays',
      'gray',
      Array.from({ length: 11 }, (_, i): [string, string] => {
        const v = Math.round((i / 10) * 255)
          .toString(16)
          .padStart(2, '0');
        return [`${100 - i * 10}% Gray`, v + v + v];
      }),
    ),
    group('Warm', 'warm', [
      ['Brick', 'a33a28'],
      ['Terracotta', 'c8643c'],
      ['Ochre', 'cc9a3d'],
      ['Sand', 'e3c99a'],
      ['Peach', 'f4b28c'],
      ['Coral', 'f0705a'],
      ['Burgundy', '6e1f2e'],
      ['Umber', '5b3a24'],
    ]),
    group('Cool', 'cool', [
      ['Navy', '1f2d5c'],
      ['Teal', '1f7a7a'],
      ['Sea', '3a9bbf'],
      ['Sky', '8fc7e8'],
      ['Mint', 'a8e0c4'],
      ['Forest', '2f5d3a'],
      ['Olive', '6f7a32'],
      ['Lavender', 'b6a6e0'],
    ]),
    group('Pastels', 'pastel', [
      ['Pastel Red', 'f7b2b2'],
      ['Pastel Orange', 'f9d1a8'],
      ['Pastel Yellow', 'f9f1a8'],
      ['Pastel Green', 'bfe8b5'],
      ['Pastel Blue', 'b5d3f2'],
      ['Pastel Purple', 'd8bff2'],
    ]),
  ];
}
