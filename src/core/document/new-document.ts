/**
 * File > New: the settings of a new document, our preset sizes, and making the document.
 *
 * Behaviour (as in the reference app): presets come in categories (Photo, Print, Art &
 * Illustration, Web, Mobile, Film & Video); a preset gives the size in its own unit
 * (inches, millimetres, pixels…), the resolution, colour mode, bit depth and background
 * contents, and every value can be changed before creating. Background Contents: White,
 * Black, the background colour, Transparent, or a custom colour. An opaque background
 * makes a locked "Background" layer; Transparent makes an ordinary "Layer 1". New
 * documents are named "Untitled-1", "Untitled-2", … (the app counts them).
 *
 * The size is kept in its unit, not in pixels, so "210 × 297 mm" stays exactly that
 * while the resolution changes; the pixel size is worked out when the document is made.
 * Colour modes: RGB and Grayscale (CMYK, Lab and Bitmap come with colour management).
 */
import { colorToSamples, type RGB } from '../color/color';
import { ImageDocument, MAX_DOCUMENT_SIDE } from './document';
import type { BitDepth } from './pixel-format';
import type { TileMemory } from './tile';
import { fromPixels, toPixels, type LengthUnit, type ResolutionUnit } from './units';

/** Units the New dialog offers for the size (no percent: there is nothing to be a percent of). */
export type SizeUnit = Exclude<LengthUnit, 'percent'>;

export const SIZE_UNITS: readonly { unit: SizeUnit; label: string }[] = [
  { unit: 'pixels', label: 'Pixels' },
  { unit: 'inches', label: 'Inches' },
  { unit: 'centimeters', label: 'Centimeters' },
  { unit: 'millimeters', label: 'Millimeters' },
  { unit: 'points', label: 'Points' },
  { unit: 'picas', label: 'Picas' },
];

export type NewDocumentMode = 'rgb' | 'grayscale';

export const NEW_DOCUMENT_MODES: readonly { mode: NewDocumentMode; label: string }[] = [
  { mode: 'rgb', label: 'RGB Color' },
  { mode: 'grayscale', label: 'Grayscale' },
];

export type BackgroundContents = 'white' | 'black' | 'background' | 'transparent' | 'custom';

export const BACKGROUND_CONTENTS: readonly { value: BackgroundContents; label: string }[] = [
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
  { value: 'background', label: 'Background Color' },
  { value: 'transparent', label: 'Transparent' },
  { value: 'custom', label: 'Custom…' },
];

export interface NewDocumentSettings {
  /** Width and height in `unit`. */
  width: number;
  height: number;
  unit: SizeUnit;
  /** Pixels per inch (shown in `resolutionUnit`). */
  resolution: number;
  resolutionUnit: ResolutionUnit;
  mode: NewDocumentMode;
  depth: BitDepth;
  background: BackgroundContents;
  /** The Custom background colour (sRGB, 0–1). */
  customColor: RGB;
}

export interface DocumentPreset {
  id: string;
  name: string;
  settings: NewDocumentSettings;
}

export interface PresetCategory {
  id: string;
  label: string;
  presets: readonly DocumentPreset[];
}

const WHITE: RGB = { r: 1, g: 1, b: 1 };

function preset(
  id: string,
  name: string,
  width: number,
  height: number,
  unit: SizeUnit,
  resolution: number,
): DocumentPreset {
  return {
    id,
    name,
    settings: {
      width,
      height,
      unit,
      resolution,
      resolutionUnit: 'ppi',
      mode: 'rgb',
      depth: 8,
      background: 'white',
      customColor: WHITE,
    },
  };
}

/** The size a fresh install offers first (also the first item of Recent). */
export const DEFAULT_DOCUMENT_PRESET: DocumentPreset = preset('default', 'Default Size', 7, 5, 'inches', 300);

/** Our preset sizes (common paper, photo, screen and video sizes). */
export const PRESET_CATEGORIES: readonly PresetCategory[] = [
  {
    id: 'photo',
    label: 'Photo',
    presets: [
      preset('photo-6x4', 'Landscape 6 × 4 in', 6, 4, 'inches', 300),
      preset('photo-7x5', 'Landscape 7 × 5 in', 7, 5, 'inches', 300),
      preset('photo-10x8', 'Landscape 10 × 8 in', 10, 8, 'inches', 300),
      preset('photo-4x6', 'Portrait 4 × 6 in', 4, 6, 'inches', 300),
      preset('photo-5x7', 'Portrait 5 × 7 in', 5, 7, 'inches', 300),
      preset('photo-8x10', 'Portrait 8 × 10 in', 8, 10, 'inches', 300),
      preset('photo-square', 'Square 8 × 8 in', 8, 8, 'inches', 300),
    ],
  },
  {
    id: 'print',
    label: 'Print',
    presets: [
      preset('print-letter', 'Letter', 8.5, 11, 'inches', 300),
      preset('print-legal', 'Legal', 8.5, 14, 'inches', 300),
      preset('print-tabloid', 'Tabloid', 11, 17, 'inches', 300),
      preset('print-a3', 'A3', 297, 420, 'millimeters', 300),
      preset('print-a4', 'A4', 210, 297, 'millimeters', 300),
      preset('print-a5', 'A5', 148, 210, 'millimeters', 300),
      preset('print-b5', 'B5', 176, 250, 'millimeters', 300),
    ],
  },
  {
    id: 'art',
    label: 'Art & Illustration',
    presets: [
      preset('art-canvas', 'Canvas 4000 × 3000 px', 4000, 3000, 'pixels', 300),
      preset('art-square', 'Square 3000 × 3000 px', 3000, 3000, 'pixels', 300),
      preset('art-poster', 'Poster 18 × 24 in', 18, 24, 'inches', 300),
      preset('art-sketch', 'Sketch 2000 × 1500 px', 2000, 1500, 'pixels', 150),
    ],
  },
  {
    id: 'web',
    label: 'Web',
    presets: [
      preset('web-1280', 'Web 1280 × 800 px', 1280, 800, 'pixels', 72),
      preset('web-1366', 'Web 1366 × 768 px', 1366, 768, 'pixels', 72),
      preset('web-1920', 'Web 1920 × 1080 px', 1920, 1080, 'pixels', 72),
      preset('web-banner', 'Banner 1200 × 628 px', 1200, 628, 'pixels', 72),
      preset('web-square', 'Square post 1080 × 1080 px', 1080, 1080, 'pixels', 72),
    ],
  },
  {
    id: 'mobile',
    label: 'Mobile',
    presets: [
      preset('mobile-phone', 'Phone 1080 × 1920 px', 1080, 1920, 'pixels', 72),
      preset('mobile-phone-tall', 'Phone 1179 × 2556 px', 1179, 2556, 'pixels', 72),
      preset('mobile-tablet', 'Tablet 1640 × 2360 px', 1640, 2360, 'pixels', 72),
      preset('mobile-tablet-large', 'Tablet 2048 × 2732 px', 2048, 2732, 'pixels', 72),
    ],
  },
  {
    id: 'film',
    label: 'Film & Video',
    presets: [
      preset('film-hd', 'HD 1280 × 720 px', 1280, 720, 'pixels', 72),
      preset('film-fullhd', 'Full HD 1920 × 1080 px', 1920, 1080, 'pixels', 72),
      preset('film-4k', '4K UHD 3840 × 2160 px', 3840, 2160, 'pixels', 72),
      preset('film-dci4k', 'DCI 4K 4096 × 2160 px', 4096, 2160, 'pixels', 72),
    ],
  },
];

/** The size in pixels (rounded, at least 1). */
export function pixelSize(s: Pick<NewDocumentSettings, 'width' | 'height' | 'unit' | 'resolution'>): {
  width: number;
  height: number;
} {
  const px = (v: number) => Math.max(1, Math.round(toPixels(v, s.unit, s.resolution, 0)));
  return { width: px(s.width), height: px(s.height) };
}

/** The same size shown in another unit. */
export function convertSize(s: NewDocumentSettings, unit: SizeUnit): NewDocumentSettings {
  if (unit === s.unit) return s;
  const to = (v: number) => fromPixels(toPixels(v, s.unit, s.resolution, 0), unit, s.resolution, 0);
  return { ...s, width: to(s.width), height: to(s.height), unit };
}

/** Why the settings cannot make a document, or null when they can. */
export function newDocumentProblem(s: NewDocumentSettings): string | null {
  if (!(s.resolution > 0) || !Number.isFinite(s.resolution)) return 'The resolution must be more than 0.';
  if (!(s.width > 0) || !(s.height > 0) || !Number.isFinite(s.width) || !Number.isFinite(s.height))
    return 'The width and height must be more than 0.';
  const { width, height } = pixelSize(s);
  if (width > MAX_DOCUMENT_SIDE || height > MAX_DOCUMENT_SIDE)
    return `The width and height can be at most ${MAX_DOCUMENT_SIDE.toLocaleString('en-US')} pixels.`;
  return null;
}

/** Bytes the new image needs (one layer), for the size readout. */
export function newDocumentBytes(s: NewDocumentSettings): number {
  const { width, height } = pixelSize(s);
  const channels = (s.mode === 'rgb' ? 3 : 1) + (s.background === 'transparent' ? 1 : 0);
  return width * height * channels * (s.depth === 8 ? 1 : s.depth === 16 ? 2 : 4);
}

/**
 * Makes the document: a Background layer in the background colour, or a transparent
 * "Layer 1". `backgroundColor` is the colour panel's background colour.
 */
export function createNewDocument(
  s: NewDocumentSettings,
  name: string,
  backgroundColor: RGB,
  memory?: TileMemory,
): ImageDocument {
  const problem = newDocumentProblem(s);
  if (problem) throw new Error(problem);
  const { width, height } = pixelSize(s);
  const doc = new ImageDocument({
    width,
    height,
    name,
    mode: s.mode,
    depth: s.depth,
    resolution: Math.round(s.resolution * 1000) / 1000,
    ...(memory ? { memory } : {}),
  });
  let layer;
  if (s.background === 'transparent') layer = doc.createPixelLayer();
  else {
    const color =
      s.background === 'white'
        ? WHITE
        : s.background === 'black'
          ? { r: 0, g: 0, b: 0 }
          : s.background === 'background'
            ? backgroundColor
            : s.customColor;
    layer = doc.createBackgroundLayer(colorToSamples(color, s.mode, s.depth));
  }
  doc.insertLayer(layer);
  doc.setActiveLayer(layer.id);
  return doc;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const unit01 = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;

/** Stored settings (possibly old or damaged) as valid settings, or null. */
export function sanitizeNewDocumentSettings(raw: unknown): NewDocumentSettings | null {
  if (!isObject(raw)) return null;
  const { width, height, unit, resolution, resolutionUnit, mode, depth, background, customColor } = raw;
  if (!positive(width) || !positive(height) || !positive(resolution)) return null;
  if (!SIZE_UNITS.some((u) => u.unit === unit)) return null;
  const color =
    isObject(customColor) && unit01(customColor['r']) && unit01(customColor['g']) && unit01(customColor['b'])
      ? { r: customColor['r'], g: customColor['g'], b: customColor['b'] }
      : WHITE;
  const settings: NewDocumentSettings = {
    width,
    height,
    unit: unit as SizeUnit,
    resolution,
    resolutionUnit: resolutionUnit === 'ppcm' ? 'ppcm' : 'ppi',
    mode: mode === 'grayscale' ? 'grayscale' : 'rgb',
    depth: depth === 16 || depth === 32 ? depth : 8,
    background: BACKGROUND_CONTENTS.some((b) => b.value === background) ? (background as BackgroundContents) : 'white',
    customColor: color,
  };
  return newDocumentProblem(settings) ? null : settings;
}

/** A stored preset list (saved presets, recent documents), keeping the valid ones. */
export function sanitizePresets(raw: unknown): DocumentPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: DocumentPreset[] = [];
  for (const item of raw) {
    if (!isObject(item) || typeof item['id'] !== 'string' || typeof item['name'] !== 'string') continue;
    const settings = sanitizeNewDocumentSettings(item['settings']);
    if (settings) out.push({ id: item['id'], name: item['name'], settings });
  }
  return out;
}

/** Whether two settings make the same document (for not listing a size twice in Recent). */
export function sameSettings(a: NewDocumentSettings, b: NewDocumentSettings): boolean {
  const pa = pixelSize(a);
  const pb = pixelSize(b);
  return (
    pa.width === pb.width &&
    pa.height === pb.height &&
    a.unit === b.unit &&
    a.resolution === b.resolution &&
    a.mode === b.mode &&
    a.depth === b.depth &&
    a.background === b.background &&
    (a.background !== 'custom' ||
      (a.customColor.r === b.customColor.r &&
        a.customColor.g === b.customColor.g &&
        a.customColor.b === b.customColor.b))
  );
}
