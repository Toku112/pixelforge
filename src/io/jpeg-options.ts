/**
 * JPEG Options, as the reference app's Save As offers them: quality 0–12 (with the
 * Low / Medium / High / Maximum presets), Baseline ("Standard"), Baseline Optimized
 * or Progressive (3–5 scans), and the matte colour that replaces transparency.
 *
 * Our encoder works with the common 1–100 quality scale; the 0–12 steps map onto it
 * below, and the lower steps (0–6) also halve the colour resolution (4:2:0), as
 * small files want (FORMAT_NOTES §5.4).
 */
import type { RGB } from '../core/color/color';

export type JpegFormat = 'baseline' | 'optimized' | 'progressive';

export interface JpegSaveOptions {
  /** 0 (smallest file) … 12 (best). */
  quality: number;
  format: JpegFormat;
  /** Progressive only. */
  scans: 3 | 4 | 5;
  /** Colour under transparent areas (JPEG has no transparency). */
  matte: RGB;
}

export const DEFAULT_JPEG_OPTIONS: JpegSaveOptions = {
  quality: 10,
  format: 'baseline',
  scans: 3,
  matte: { r: 1, g: 1, b: 1 },
};

/** Encoder quality (1–100) for each step 0–12. */
const QUALITY_STEPS = [10, 18, 25, 32, 40, 50, 60, 70, 78, 85, 90, 95, 100];

export const JPEG_PRESETS: readonly { id: string; label: string; quality: number; range: [number, number] }[] = [
  { id: 'low', label: 'Low', quality: 3, range: [0, 4] },
  { id: 'medium', label: 'Medium', quality: 5, range: [5, 7] },
  { id: 'high', label: 'High', quality: 8, range: [8, 9] },
  { id: 'maximum', label: 'Maximum', quality: 10, range: [10, 12] },
];

/** The preset a quality falls in. */
export function jpegPreset(quality: number): string {
  return JPEG_PRESETS.find((p) => quality >= p.range[0] && quality <= p.range[1])?.id ?? 'maximum';
}

/** What the encoder is told for these options. */
export function jpegEncoderSettings(options: JpegSaveOptions): {
  quality: number;
  subsample: boolean;
  mode: 0 | 1 | 2;
  scans: number;
} {
  const step = Math.min(12, Math.max(0, Math.round(options.quality)));
  return {
    quality: QUALITY_STEPS[step]!,
    subsample: step <= 6,
    mode: options.format === 'baseline' ? 0 : options.format === 'optimized' ? 1 : 2,
    scans: options.scans,
  };
}
