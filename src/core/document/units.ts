/**
 * Length units of the size dialogs (Image Size, Canvas Size, New Document). Physical
 * units go through the document resolution (pixels per inch); percent is relative
 * to a base size in pixels.
 */
export type LengthUnit = 'pixels' | 'percent' | 'inches' | 'centimeters' | 'millimeters' | 'points' | 'picas';

export const LENGTH_UNITS: readonly { unit: LengthUnit; label: string }[] = [
  { unit: 'pixels', label: 'Pixels' },
  { unit: 'percent', label: 'Percent' },
  { unit: 'inches', label: 'Inches' },
  { unit: 'centimeters', label: 'Centimeters' },
  { unit: 'millimeters', label: 'Millimeters' },
  { unit: 'points', label: 'Points' },
  { unit: 'picas', label: 'Picas' },
];

/** How many of the unit make an inch (physical units only). */
const PER_INCH: Partial<Record<LengthUnit, number>> = {
  inches: 1,
  centimeters: 2.54,
  millimeters: 25.4,
  points: 72,
  picas: 6,
};

export const isPhysicalUnit = (unit: LengthUnit): boolean => PER_INCH[unit] !== undefined;

/** A length in `unit` as pixels (may be fractional). `base`: the pixels that are 100 %. */
export function toPixels(value: number, unit: LengthUnit, ppi: number, base: number): number {
  if (unit === 'pixels') return value;
  if (unit === 'percent') return (value / 100) * base;
  return (value / PER_INCH[unit]!) * ppi;
}

/** Pixels as a length in `unit`. */
export function fromPixels(px: number, unit: LengthUnit, ppi: number, base: number): number {
  if (unit === 'pixels') return px;
  if (unit === 'percent') return base === 0 ? 0 : (px / base) * 100;
  return (px / ppi) * PER_INCH[unit]!;
}

/** Decimal places the dialogs show for a unit. */
export function unitDecimals(unit: LengthUnit): number {
  return unit === 'pixels' ? 0 : unit === 'percent' || unit === 'points' || unit === 'picas' ? 2 : 3;
}

export type ResolutionUnit = 'ppi' | 'ppcm';

export const toPpi = (value: number, unit: ResolutionUnit): number => (unit === 'ppi' ? value : value * 2.54);
export const fromPpi = (ppi: number, unit: ResolutionUnit): number => (unit === 'ppi' ? ppi : ppi / 2.54);

/** Memory a single-layer image of this size needs, as the size dialogs show it ("1.2M", "540K"). */
export function formatImageBytes(bytes: number): string {
  const k = bytes / 1024;
  if (k < 1024) return `${k < 10 ? k.toFixed(1) : Math.round(k)}K`;
  const m = k / 1024;
  if (m < 1024) return `${m < 10 ? m.toFixed(1) : m.toFixed(m < 100 ? 1 : 0)}M`;
  return `${(m / 1024).toFixed(1)}G`;
}
