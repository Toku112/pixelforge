/**
 * Our brush preset file (.pfbrush): JSON with the presets, plus the pixels of the
 * sampled tips and patterns they use (base64). Built-in tips and patterns are left
 * out: every copy of the app has them.
 */
import { parsePreset, type BrushBundle } from '../core/paint/presets';

export const BRUSH_FILE_FORMAT = 'pixelforge-brushes';
export const BRUSH_FILE_EXTENSION = 'pfbrush';

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function writeBrushFile(bundle: BrushBundle): Uint8Array {
  const image = (i: { id: string; name: string; width: number; height: number; data: Uint8Array }) => ({
    id: i.id,
    name: i.name,
    width: i.width,
    height: i.height,
    data: toBase64(i.data),
  });
  const json = {
    format: BRUSH_FILE_FORMAT,
    version: 1,
    presets: bundle.presets,
    tips: bundle.tips.map(image),
    patterns: bundle.patterns.map(image),
  };
  return new TextEncoder().encode(JSON.stringify(json));
}

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

function readImage(raw: unknown, channels: 1 | 4, what: string) {
  const damaged = () => new Error(`This brush preset file is damaged (a ${what})`);
  if (!isRaw(raw)) throw damaged();
  const { id, name, width, height, data } = raw;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof data !== 'string') throw damaged();
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height))
    throw damaged();
  if (width < 1 || height < 1) throw damaged();
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(data);
  } catch {
    throw damaged();
  }
  if (bytes.length !== width * height * channels) throw damaged();
  return { id, name, width, height, data: bytes };
}

/** Reads our brush preset file, refusing anything else (or a damaged one). */
export function readBrushFile(bytes: Uint8Array): BrushBundle {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('This is not a brush preset file');
  }
  if (!isRaw(json) || json['format'] !== BRUSH_FILE_FORMAT) throw new Error('This is not a brush preset file');
  if (json['version'] !== 1) throw new Error('This brush preset file was made by a newer version of the app');
  const list = (key: string) => (Array.isArray(json[key]) ? (json[key] as unknown[]) : []);
  return {
    presets: list('presets').map((p) => parsePreset(p)),
    tips: list('tips').map((t) => readImage(t, 1, 'brush tip')),
    patterns: list('patterns').map((p) => readImage(p, 4, 'pattern')),
  };
}
