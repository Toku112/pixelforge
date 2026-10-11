/**
 * Dodge, Burn and Sponge: brushes that change the tones of the pixels they pass over
 * instead of painting a colour.
 *
 * Behaviour (own summary of the reference app):
 * - Dodge lightens, Burn darkens. Range picks the tones affected most: Shadows,
 *   Midtones or Highlights. Exposure sets how strong a stroke is; painting over an
 *   area again strengthens the effect. Protect Tones keeps colours from shifting in hue
 *   and from clipping to white or black. Alt/Option switches between Dodge and Burn
 *   while held.
 * - Sponge saturates or desaturates colours (in Grayscale it raises or lowers the
 *   contrast, moving grays away from or towards middle gray); Flow sets how quickly.
 *   Vibrance spares colours that are already nearly fully saturated or unsaturated,
 *   so they do not clip.
 * - None of them work on 32-bit images.
 *
 * Model (ours; docs/FORMAT_NOTES.md §16). A stroke's amount at a pixel, a (0–1), is
 * Exposure (Dodge, Burn) or 100 % (Sponge) times the stroke's coverage there, built up by
 * the dabs as a brush's paint is (Flow); the pixel is recomputed from its value before
 * the stroke, so one stroke never goes past its amount.
 */

export type ToneRange = 'shadows' | 'midtones' | 'highlights';

export const TONE_RANGES: readonly [ToneRange, string][] = [
  ['shadows', 'Shadows'],
  ['midtones', 'Midtones'],
  ['highlights', 'Highlights'],
];

/** The Dodge and Burn tools' options. */
export interface DodgeOptions {
  range: ToneRange;
  /** 0.01–1. */
  exposure: number;
  protectTones: boolean;
}

export const DEFAULT_DODGE: Readonly<DodgeOptions> = Object.freeze({
  range: 'midtones',
  exposure: 0.5,
  protectTones: true,
});

/** The Sponge tool's options (its Flow is the brush's). */
export interface SpongeOptions {
  /** Saturate (otherwise desaturate). */
  saturate: boolean;
  vibrance: boolean;
}

export const DEFAULT_SPONGE: Readonly<SpongeOptions> = Object.freeze({ saturate: false, vibrance: true });

/** How a stroke changes tones (StrokeSetup.tone). */
export type ToneSetup =
  | { kind: 'dodge' | 'burn'; range: ToneRange; protect: boolean }
  | { kind: 'sponge'; saturate: boolean; vibrance: boolean };

/** How much Dodge and Burn change a tone at full amount (share of the way to white or black). */
const TONE_STRENGTH = 0.5;
/** How much Sponge changes saturation (or gray contrast) at full amount. */
const SPONGE_STRENGTH = 0.75;

/** How much a range touches a tone v (0–1): Shadows the darks, Midtones the middle, Highlights the lights. */
export function rangeWeight(range: ToneRange, v: number): number {
  const t = Math.min(1, Math.max(0, v));
  switch (range) {
    case 'shadows':
      return (1 - t) * (1 - t);
    case 'highlights':
      return t * t;
    default:
      return 4 * t * (1 - t);
  }
}

/** A tone v (0–1) dodged (lightened) or burned (darkened) by amount a. */
export function toneValue(kind: 'dodge' | 'burn', range: ToneRange, v: number, a: number): number {
  const w = rangeWeight(range, v) * a * TONE_STRENGTH;
  return kind === 'dodge' ? v + (1 - v) * w : v - v * w;
}

/** Luminance of colour samples 0–1 (one channel: itself; three: the usual weights; others: the mean). */
export function luminance(c: ArrayLike<number>, channels: number): number {
  if (channels === 1) return c[0]!;
  if (channels === 3) return 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;
  let sum = 0;
  for (let i = 0; i < channels; i++) sum += c[i]!;
  return sum / channels;
}

/**
 * Changes colour samples `c` (0–1, `channels` of them) in place by amount `a` (0–1) as `tone` says.
 * Results stay within 0–1.
 */
export function applyTone(tone: ToneSetup, c: number[] | Float32Array, channels: number, a: number): void {
  if (a <= 0) return;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  for (let i = 0; i < channels; i++) c[i] = clamp(c[i]!);
  if (tone.kind === 'sponge') {
    sponge(tone, c, channels, a);
    return;
  }
  if (channels === 1 || !tone.protect) {
    // Each channel by its own tone: colours may shift in hue.
    for (let i = 0; i < channels; i++) c[i] = clamp(toneValue(tone.kind, tone.range, c[i]!, a));
    return;
  }
  // Protect Tones: the luminance changes and the colour keeps its hue; nothing clips.
  const l = luminance(c, channels);
  const next = toneValue(tone.kind, tone.range, l, a);
  if (tone.kind === 'dodge') {
    if (l >= 1) return;
    const k = (1 - next) / (1 - l);
    for (let i = 0; i < channels; i++) c[i] = clamp(1 - (1 - c[i]!) * k);
  } else {
    if (l <= 0) return;
    const k = next / l;
    for (let i = 0; i < channels; i++) c[i] = clamp(c[i]! * k);
  }
}

function sponge(
  tone: { saturate: boolean; vibrance: boolean },
  c: number[] | Float32Array,
  channels: number,
  a: number,
) {
  const amount = a * SPONGE_STRENGTH;
  if (channels === 1) {
    // Grayscale: contrast around middle gray.
    const v = c[0]!;
    const d = v - 0.5;
    // Vibrance: tones near black and white move less, so they do not clip.
    const room = tone.vibrance ? 1 - Math.abs(d) * 2 : 1;
    c[0] = Math.min(1, Math.max(0, tone.saturate ? 0.5 + d * (1 + amount * room) : v - d * amount * room));
    return;
  }
  const gray = luminance(c, channels);
  let max = 0;
  let min = 1;
  for (let i = 0; i < channels; i++) {
    max = Math.max(max, c[i]!);
    min = Math.min(min, c[i]!);
  }
  const saturation = max > 0 ? (max - min) / max : 0;
  if (!tone.saturate) {
    // Vibrance: nearly gray colours lose less.
    const t = amount * (tone.vibrance ? Math.sqrt(saturation) : 1);
    for (let i = 0; i < channels; i++) c[i] = c[i]! + (gray - c[i]!) * t;
    return;
  }
  let factor = 1 + amount;
  if (tone.vibrance) {
    // Already saturated colours gain less, and no channel goes past black or white.
    factor = 1 + amount * (1 - saturation);
    for (let i = 0; i < channels; i++) {
      const d = c[i]! - gray;
      if (d > 1e-6) factor = Math.min(factor, (1 - gray) / d);
      else if (d < -1e-6) factor = Math.min(factor, gray / -d);
    }
    factor = Math.max(1, factor);
  }
  for (let i = 0; i < channels; i++) c[i] = Math.min(1, Math.max(0, gray + (c[i]! - gray) * factor));
}

/** A recorded stroke's tone settings, checked. */
export function parseTone(v: unknown, tool: 'dodge' | 'burn' | 'sponge'): ToneSetup {
  const o = (v ?? {}) as Record<string, unknown>;
  if (tool === 'sponge') return { kind: 'sponge', saturate: o['saturate'] === true, vibrance: o['vibrance'] !== false };
  const range = o['range'] ?? DEFAULT_DODGE.range;
  if (!TONE_RANGES.some(([r]) => r === range))
    throw new Error('paintStroke: range must be shadows, midtones or highlights');
  return { kind: tool, range: range as ToneRange, protect: o['protect'] !== false };
}
