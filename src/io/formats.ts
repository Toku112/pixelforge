/**
 * File format registry: what the app can open and save, by extension, MIME type
 * and file signature. Codecs themselves run in the codec worker.
 */
import type { ImageDocument } from '../core/document/document';

export interface FileFormat {
  readonly id: 'psd' | 'png' | 'jpeg' | 'webp';
  readonly name: string;
  readonly extensions: readonly string[];
  readonly mimeType: string;
  readonly canOpen: boolean;
  /** Saving is available in this build (formats without an encoder yet are not offered). */
  readonly canSave: boolean;
  /** The format holds layers (others save a flattened copy). */
  readonly keepsLayers: boolean;
  /** Why the document cannot be saved in this format, or null if it can. */
  saveRestriction(doc: ImageDocument): string | null;
}

/** JPEG and WebP: 8-bit gray or RGB, flattened. */
function flatRestriction(name: string, doc: ImageDocument): string | null {
  if (doc.depth === 32) return `${name} cannot store 32-bit images; convert to 8 or 16 bits/channel first`;
  if (doc.mode !== 'rgb' && doc.mode !== 'grayscale') return `${name} supports RGB and Grayscale images only`;
  return null;
}

export const FORMATS: readonly FileFormat[] = [
  {
    id: 'psd',
    name: 'PSD',
    extensions: ['.psd', '.psb'],
    // The registered PSD media type names the vendor (CLAUDE.md §1.1): pickers and downloads use the extensions.
    mimeType: 'application/octet-stream',
    canOpen: true,
    canSave: true,
    keepsLayers: true,
    saveRestriction(doc) {
      if (doc.mode !== 'rgb' || doc.depth !== 8)
        return 'PSD files can be saved from 8-bit RGB documents for now (other modes and depths come later)';
      return null;
    },
  },
  {
    id: 'png',
    name: 'PNG',
    extensions: ['.png'],
    mimeType: 'image/png',
    canOpen: true,
    canSave: true,
    keepsLayers: false,
    saveRestriction(doc) {
      if (doc.depth === 32) return 'PNG cannot store 32-bit images; convert to 8 or 16 bits/channel first';
      if (doc.mode !== 'rgb' && doc.mode !== 'grayscale') return 'PNG supports RGB and Grayscale images only';
      return null;
    },
  },
  {
    id: 'jpeg',
    name: 'JPEG',
    extensions: ['.jpg', '.jpeg', '.jpe', '.jfif'],
    mimeType: 'image/jpeg',
    canOpen: true,
    canSave: true,
    keepsLayers: false,
    saveRestriction(doc) {
      if (doc.width > 65535 || doc.height > 65535) return 'JPEG images can be at most 65535 pixels wide and high';
      return flatRestriction('JPEG', doc);
    },
  },
  {
    id: 'webp',
    name: 'WebP',
    extensions: ['.webp'],
    mimeType: 'image/webp',
    canOpen: true,
    canSave: true,
    keepsLayers: false,
    saveRestriction(doc) {
      if (doc.width > 16383 || doc.height > 16383) return 'WebP images can be at most 16383 pixels wide and high';
      return flatRestriction('WebP', doc);
    },
  },
];

/** Identifies a format from the first bytes of a file. */
export function detectFormat(bytes: Uint8Array): FileFormat | undefined {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return formatById('png');
  if (starts([0x38, 0x42, 0x50, 0x53])) return formatById('psd'); // "8BPS"
  if (starts([0xff, 0xd8, 0xff])) return formatById('jpeg');
  if (
    starts([0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return formatById('webp');
  }
  return undefined;
}

export function formatById(id: FileFormat['id']): FileFormat {
  return FORMATS.find((f) => f.id === id)!;
}

export function formatFromFileName(name: string): FileFormat | undefined {
  const lower = name.toLowerCase();
  return FORMATS.find((f) => f.extensions.some((ext) => lower.endsWith(ext)));
}

/** File-picker accept map for every openable format. */
export function openAcceptTypes(): Record<string, string[]> {
  const accept: Record<string, string[]> = {};
  for (const f of FORMATS) if (f.canOpen) accept[f.mimeType] = [...f.extensions];
  return accept;
}

/** Replaces (or adds) a file name's extension. */
export function withExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name) + extension;
}
