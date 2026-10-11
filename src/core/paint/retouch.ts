/**
 * Blur, Sharpen and Smudge: brushes that work on the pixels they pass over.
 *
 * Behaviour (own summary of the reference app):
 * - Blur softens: neighbouring pixels become more alike. Sharpen does the opposite,
 *   raising the contrast along edges; Protect Detail keeps it from bringing out noise,
 *   colour fringes and halos. Painting over an area again blurs or sharpens it more.
 *   Alt/Option switches between the two while a stroke is painted.
 * - Smudge pushes colour along: it takes up the colour where the stroke starts and drags
 *   it in the direction of the stroke. Finger Painting starts each stroke with the
 *   foreground colour instead (Alt/Option switches it for a stroke).
 * - Strength sets how strong each tool is. Mode limits the change (Darken: only
 *   darker; Lighten: only lighter; Hue, Saturation, Color, Luminosity: only that part of
 *   the colour). Sample All Layers works with what all visible layers show, putting the
 *   result on the active layer.
 *
 * Model (ours; docs/FORMAT_NOTES.md §17). Each dab works on what the dabs before it left,
 * by its share of the distance painted, so the spacing hardly matters. Blur pulls each
 * pixel towards a Gaussian blur of its surroundings (radius growing with the brush size)
 * and Sharpen pushes it away (unsharp masking), by Strength per quarter diameter; Smudge
 * carries colour under each pixel of its tip, laying down Strength of it and taking up the
 * rest from the canvas per diameter painted. Only the canvas is read and changed.
 */
import type { FlattenPlan } from '../composite/flatten';
import { blendChannel, blendColor } from '../composite/blend';
import { tileIndex, tileKey, TILE_SIZE } from '../document/tile';
import { dabBounds, type BrushSettings, type Dab } from './brush';
import { DabPainter } from './dab-painter';
import { luminance } from './tone';
import type { StrokeSetup } from './stroke';
import { addNoise } from './texture';

export type RetouchKind = 'blur' | 'sharpen' | 'smudge';
export type RetouchMode = 'normal' | 'darken' | 'lighten' | 'hue' | 'saturation' | 'color' | 'luminosity';

export const RETOUCH_MODES: readonly [RetouchMode, string][] = [
  ['normal', 'Normal'],
  ['darken', 'Darken'],
  ['lighten', 'Lighten'],
  ['hue', 'Hue'],
  ['saturation', 'Saturation'],
  ['color', 'Color'],
  ['luminosity', 'Luminosity'],
];

/** The modes for a document with this many colour channels (the colour modes need three). */
export function retouchModes(colorChannels: number): readonly [RetouchMode, string][] {
  return colorChannels === 3 ? RETOUCH_MODES : RETOUCH_MODES.slice(0, 3);
}

/** The Blur, Sharpen and Smudge tools' options. */
export interface RetouchOptions {
  mode: RetouchMode;
  /** 0.01–1. */
  strength: number;
  sampleAllLayers: boolean;
  /** Sharpen. */
  protectDetail: boolean;
  /** Smudge. */
  fingerPainting: boolean;
}

export const DEFAULT_RETOUCH: Readonly<RetouchOptions> = Object.freeze({
  mode: 'normal',
  strength: 0.5,
  sampleAllLayers: false,
  protectDetail: true,
  fingerPainting: false,
});

/** What a stroke records: the mode, Strength, Sample All Layers, and Protect Detail (Sharpen) or Finger Painting (Smudge). */
export interface RetouchStroke {
  mode: RetouchMode;
  strength: number;
  sampleAllLayers: boolean;
  protectDetail?: boolean;
  finger?: boolean;
}

/** The renderer's part of a stroke (StrokeSetup.retouch). */
export interface RetouchSetup extends RetouchStroke {
  kind: RetouchKind;
  /** Finger Painting: the foreground colour (colour samples 0–1). */
  fingerColor: number[] | null;
  /** Side of the square of colour the Smudge carries (odd). */
  side: number;
  /** The brush's spacing (share of the diameter): how far a dab that did not move counts as painting. */
  spacing: number;
  /** Sample All Layers: the image under the active layer, and the layer's opacity × fill. */
  below: FlattenPlan | null;
  layerOpacity: number;
}

/** Strength is the change of one dab this far (in diameters) from the one before. */
const STEP_UNIT = 0.25;
/** How far Sharpen pushes a pixel from the blur of its surroundings, at full strength. */
const SHARPEN_AMOUNT = 1;
/** Protect Detail: luminance differences below this (0–1) are sharpened less, so noise is not brought out. */
const NOISE_LEVEL = 0.02;

/** Blur and Sharpen's blur radius (px) for a dab size: grows with the brush, 1–6. */
export function blurRadius(size: number): number {
  return Math.min(6, Math.max(1, Math.round(size / 40)));
}

/** How far beyond its dabs a Blur or Sharpen stroke reads the pixels (px), for a brush; 0 for the Smudge. */
export function retouchMargin(kind: RetouchKind, brush: BrushSettings): number {
  if (kind === 'smudge') return 0;
  const sh = brush.dynamics?.shape;
  const grow = sh?.enabled && sh.size.control === 'tilt' ? 1 + sh.tiltScale : 1;
  return blurRadius(brush.size * grow) + 2;
}

/** Gaussian weights for a radius (index 0 the centre), summing to 1 over −r…r. */
function gaussian(r: number): Float32Array {
  const sigma = Math.max(0.7, r / 1.5);
  const w = new Float32Array(r + 1);
  let sum = 0;
  for (let i = 0; i <= r; i++) {
    w[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += i === 0 ? w[i]! : 2 * w[i]!;
  }
  for (let i = 0; i <= r; i++) w[i] = w[i]! / sum;
  return w;
}

/** What one dab does at coverage c and travel `step`, for a change `strength` per STEP_UNIT. */
function dabAmount(strength: number, cov: number, step: number): number {
  if (strength <= 0 || cov <= 0) return 0;
  if (strength >= 0.999 && cov >= 1) return 1;
  return 1 - Math.exp(Math.log(1 - Math.min(0.999, strength)) * cov * (step / STEP_UNIT));
}

interface Carried {
  /** Colour the Smudge carries, per pixel of a side × side square centred on the tip (premultiplied). */
  color: Float32Array;
  filled: Uint8Array;
  last: { x: number; y: number } | null;
}

export class RetouchRenderer extends DabPainter {
  readonly #r: RetouchSetup;
  readonly #hdr: boolean;
  readonly #carried: Carried | null;
  #last: { x: number; y: number } | null = null;
  // Scratch, one pixel each.
  readonly #layer: Float32Array;
  readonly #canvas: Float32Array;
  readonly #target: Float32Array;
  readonly #out: Float32Array;
  readonly #a: number[] = [];
  readonly #b: number[] = [];

  constructor(setup: StrokeSetup) {
    const r = setup.retouch;
    if (!r) throw new Error('Retouch: the stroke has no Blur, Sharpen or Smudge settings');
    super(setup, r.below, r.layerOpacity);
    this.#r = r;
    this.#hdr = setup.format.depth === 32;
    const side = Math.max(1, r.side | 1);
    this.#carried =
      r.kind === 'smudge'
        ? { color: new Float32Array(side * side * this.n), filled: new Uint8Array(side * side), last: null }
        : null;
    this.#layer = new Float32Array(this.n);
    this.#canvas = new Float32Array(this.n);
    this.#target = new Float32Array(this.n);
    this.#out = new Float32Array(this.n);
  }

  applyDabs(dabs: readonly Dab[]): Set<number> {
    const changed = new Set<number>();
    for (const dab of dabs) {
      if (dab.dual) continue; // the Dual Brush does not apply
      // How far this dab moves the brush, in diameters (the first: one step; still: one spacing step).
      const last = this.#last;
      const moved = last ? Math.hypot(dab.x - last.x, dab.y - last.y) / dab.size : STEP_UNIT;
      const step = Math.min(1, Math.max(0.01, moved > 0 ? moved : this.#r.spacing));
      if (this.#r.kind === 'smudge') this.#smudge(dab, step, changed);
      else this.#filter(dab, step, changed);
      this.#last = { x: dab.x, y: dab.y };
    }
    return changed;
  }

  /** The mode's result of `target` over the layer pixel `layer` (premultiplied), into `target`. */
  #applyMode(layer: Float32Array, target: Float32Array): void {
    const mode = this.#r.mode;
    if (mode === 'normal') return;
    const cc = this.cc;
    const la = layer[cc]!;
    const ta = target[cc]!;
    if (la <= 0 || ta <= 0) return;
    const b = this.#a;
    const s = this.#b;
    for (let c = 0; c < cc; c++) {
      b[c] = layer[c]! / la;
      s[c] = target[c]! / ta;
    }
    if (cc === 3 && (mode === 'hue' || mode === 'saturation' || mode === 'color' || mode === 'luminosity')) {
      const out = blendColor(mode, b, s, this.#hdr);
      for (let c = 0; c < 3; c++) target[c] = out[c]! * ta;
      return;
    }
    for (let c = 0; c < cc; c++) target[c] = blendChannel(mode, b[c]!, s[c]!, 1, this.#hdr) * ta;
  }

  /** Moves the layer pixel at sample index `i` towards `target` by `k` and writes it. */
  #deposit(tile: Parameters<DabPainter['write']>[0], i: number, target: Float32Array, k: number): void {
    const L = this.#layer;
    const O = this.#out;
    const n = this.n;
    this.#applyMode(L, target);
    for (let c = 0; c < n; c++) O[c] = L[c]! + (target[c]! - L[c]!) * k;
    this.write(tile, i, O, L[n - 1]!);
  }

  /** Blur and Sharpen: each covered pixel towards (or away from) the blur of its surroundings. */
  #filter(dab: Dab, step: number, changed: Set<number>): void {
    const s = this.setup;
    const r = this.#r;
    const n = this.n;
    const shape = this.shape(dab);
    const b = dabBounds(dab, this.tip !== null);
    const radius = blurRadius(dab.size);
    const margin = radius + 1;
    // The canvas over the dab and a margin around it, as it is before this dab (layer coordinates).
    const gx0 = b.x - s.offsetX - margin;
    const gy0 = b.y - s.offsetY - margin;
    const gw = b.w + 2 * margin;
    const gh = b.h + 2 * margin;
    const src = new Float32Array(gw * gh * n);
    const L = this.#layer;
    const C = this.#canvas;
    // Beyond the canvas edge the nearest canvas pixel stands in.
    const canvas = s.canvas;
    const clampX = (lx: number) =>
      canvas ? Math.min(canvas.x + canvas.w - 1, Math.max(canvas.x, lx + s.offsetX)) - s.offsetX : lx;
    const clampY = (ly: number) =>
      canvas ? Math.min(canvas.y + canvas.h - 1, Math.max(canvas.y, ly + s.offsetY)) - s.offsetY : ly;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const at = this.tileAt(clampX(gx0 + x), clampY(gy0 + y));
        if (!at) continue; // outside the stroke's tiles: nothing (the margin keeps this rare)
        this.read(at.tile.data, at.p * this.spp, L);
        this.canvasAt(L, at.tile.below, at.p, C);
        src.set(C, (y * gw + x) * n);
      }
    }
    // Separable Gaussian blur of the area.
    const w = gaussian(radius);
    const across = new Float32Array(src.length);
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        const o = (y * gw + x) * n;
        for (let k = -radius; k <= radius; k++) {
          const xx = Math.min(gw - 1, Math.max(0, x + k));
          const wk = w[Math.abs(k)]!;
          const so = (y * gw + xx) * n;
          for (let c = 0; c < n; c++) across[o + c] = across[o + c]! + src[so + c]! * wk;
        }
      }
    const blurred = new Float32Array(src.length);
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        const o = (y * gw + x) * n;
        for (let k = -radius; k <= radius; k++) {
          const yy = Math.min(gh - 1, Math.max(0, y + k));
          const wk = w[Math.abs(k)]!;
          const so = (yy * gw + x) * n;
          for (let c = 0; c < n; c++) blurred[o + c] = blurred[o + c]! + across[so + c]! * wk;
        }
      }
    const T = this.#target;
    const strength = r.strength;
    const lx0 = b.x - s.offsetX;
    const ly0 = b.y - s.offsetY;
    for (let ty = tileIndex(ly0); ty <= tileIndex(ly0 + b.h - 1); ty++) {
      for (let tx = tileIndex(lx0); tx <= tileIndex(lx0 + b.w - 1); tx++) {
        const tile = this.tiles.get(tileKey(tx, ty));
        if (!tile) continue;
        const x0 = Math.max(lx0, tx * TILE_SIZE);
        const y0 = Math.max(ly0, ty * TILE_SIZE);
        const x1 = Math.min(lx0 + b.w, (tx + 1) * TILE_SIZE);
        const y1 = Math.min(ly0 + b.h, (ty + 1) * TILE_SIZE);
        let any = false;
        for (let ly = y0; ly < y1; ly++) {
          const y = ly + s.offsetY;
          const dy = y + 0.5 - dab.y;
          for (let lx = x0; lx < x1; lx++) {
            const x = lx + s.offsetX;
            let cov = shape.at(x + 0.5 - dab.x, dy);
            if (cov <= 0 || !this.inCanvas(x, y)) continue;
            if (s.noise) cov = addNoise(cov, x, y);
            const p = (ly - ty * TILE_SIZE) * TILE_SIZE + (lx - tx * TILE_SIZE);
            const k = dabAmount(strength, cov, step) * this.selected(tile, p);
            if (k <= 0) continue;
            const g = ((ly - gy0) * gw + (lx - gx0)) * n;
            if (r.kind === 'blur') {
              for (let c = 0; c < n; c++) T[c] = blurred[g + c]!;
            } else {
              this.#sharpened(src, blurred, g, gw, T, r.protectDetail === true);
            }
            const i = p * this.spp;
            this.read(tile.data, i, L);
            this.#deposit(tile, i, T, k);
            any = true;
          }
        }
        if (any) changed.add(tileKey(tx, ty));
      }
    }
  }

  /** Sharpen's target for area pixel `g`: the pixel pushed away from its blur (Protect Detail: gently). */
  #sharpened(
    src: Float32Array,
    blurred: Float32Array,
    g: number,
    gw: number,
    out: Float32Array,
    protect: boolean,
  ): void {
    const n = this.n;
    const cc = this.cc;
    const hdr = this.#hdr;
    const a = src[g + cc]!;
    if (!protect) {
      // Every channel by its own difference: strong, and noise and colour fringes come out too.
      const alpha = Math.min(1, Math.max(0, a + (a - blurred[g + cc]!) * SHARPEN_AMOUNT));
      out[cc] = alpha;
      for (let c = 0; c < cc; c++) {
        const v = src[g + c]! + (src[g + c]! - blurred[g + c]!) * SHARPEN_AMOUNT;
        out[c] = Math.max(0, hdr ? v : Math.min(alpha, v));
      }
      return;
    }
    // Protect Detail: the luminance difference only (no colour fringes), less where it is as small as
    // noise, and never past the brightest or darkest of the pixel's neighbours (no halos).
    const d = luminance(this.#diff(src, blurred, g), cc);
    const m = Math.abs(d) < NOISE_LEVEL ? (Math.abs(d) / NOISE_LEVEL) ** 2 : 1;
    out[cc] = a;
    const row = gw * n;
    for (let c = 0; c < cc; c++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const o of [-row - n, -row, -row + n, -n, 0, n, row - n, row, row + n]) {
        const v = src[g + o + c]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      out[c] = Math.min(hi, Math.max(lo, src[g + c]! + d * a * m * SHARPEN_AMOUNT));
    }
  }

  /** The straight colour difference between area pixel `g` and its blur (scratch, valid until the next call). */
  #diff(src: Float32Array, blurred: Float32Array, g: number): number[] {
    const cc = this.cc;
    const out = this.#a;
    const a = src[g + cc]!;
    const ab = blurred[g + cc]!;
    for (let c = 0; c < cc; c++) out[c] = (a > 0 ? src[g + c]! / a : 0) - (ab > 0 ? blurred[g + c]! / ab : 0);
    return out;
  }

  /**
   * Smudge: the tip carries colour under each of its pixels. Moving one diameter, it takes up
   * 1 − Strength of the canvas under it and lays down Strength of what it carries.
   */
  #smudge(dab: Dab, step: number, changed: Set<number>): void {
    const s = this.setup;
    const r = this.#r;
    const carried = this.#carried!;
    const n = this.n;
    const cc = this.cc;
    const side = Math.max(1, r.side | 1);
    const half = (side - 1) / 2;
    const shape = this.shape(dab);
    const b = dabBounds(dab, this.tip !== null);
    const strength = Math.min(1, Math.max(0, r.strength));
    const keepLog = Math.log(Math.max(1e-6, strength));
    const finger = r.finger && r.fingerColor ? r.fingerColor : null;
    const cx = Math.floor(dab.x);
    const cy = Math.floor(dab.y);
    const L = this.#layer;
    const C = this.#canvas;
    const T = this.#target;
    const lx0 = b.x - s.offsetX;
    const ly0 = b.y - s.offsetY;
    for (let ty = tileIndex(ly0); ty <= tileIndex(ly0 + b.h - 1); ty++) {
      for (let tx = tileIndex(lx0); tx <= tileIndex(lx0 + b.w - 1); tx++) {
        const tile = this.tiles.get(tileKey(tx, ty));
        if (!tile) continue;
        const x0 = Math.max(lx0, tx * TILE_SIZE);
        const y0 = Math.max(ly0, ty * TILE_SIZE);
        const x1 = Math.min(lx0 + b.w, (tx + 1) * TILE_SIZE);
        const y1 = Math.min(ly0 + b.h, (ty + 1) * TILE_SIZE);
        let any = false;
        for (let ly = y0; ly < y1; ly++) {
          const y = ly + s.offsetY;
          const dy = y + 0.5 - dab.y;
          const gy = y - cy + half;
          for (let lx = x0; lx < x1; lx++) {
            const x = lx + s.offsetX;
            let cov = shape.at(x + 0.5 - dab.x, dy);
            if (cov <= 0 || !this.inCanvas(x, y)) continue;
            if (s.noise) cov = addNoise(cov, x, y);
            const gx = x - cx + half;
            if (gx < 0 || gx >= side || gy < 0 || gy >= side) continue;
            const g = gy * side + gx;
            const p = (ly - ty * TILE_SIZE) * TILE_SIZE + (lx - tx * TILE_SIZE);
            const i = p * this.spp;
            this.read(tile.data, i, L);
            this.canvasAt(L, tile.below, p, C);
            const o = g * n;
            if (!carried.filled[g]) {
              // The stroke starts with the canvas here, or the foreground colour (Finger Painting).
              if (finger) {
                for (let c = 0; c < cc; c++) carried.color[o + c] = finger[c]!;
                carried.color[o + cc] = 1;
              } else {
                carried.color.set(C, o);
              }
              carried.filled[g] = 1;
            } else if (strength < 1) {
              // Taking up the canvas as it was before this dab.
              const take = 1 - Math.exp(keepLog * cov * step);
              for (let c = 0; c < n; c++)
                carried.color[o + c] = carried.color[o + c]! + (C[c]! - carried.color[o + c]!) * take;
            }
            const k = dabShare(strength, cov, step) * this.selected(tile, p);
            if (k <= 0) continue;
            for (let c = 0; c < n; c++) T[c] = carried.color[o + c]!;
            this.#deposit(tile, i, T, k);
            any = true;
          }
        }
        if (any) changed.add(tileKey(tx, ty));
      }
    }
  }
}

/** What one Smudge dab lays down at coverage c and travel `step` (diameters), for `strength` per diameter. */
function dabShare(strength: number, cov: number, step: number): number {
  if (strength <= 0 || cov <= 0) return 0;
  if (strength >= 0.999 && cov >= 1) return 1;
  return 1 - Math.exp(Math.log(1 - Math.min(0.999, strength)) * cov * step);
}

/** A recorded stroke's Blur, Sharpen or Smudge settings, checked. */
export function parseRetouch(v: unknown, kind: RetouchKind): RetouchStroke {
  const o = (v ?? {}) as Record<string, unknown>;
  const mode = o['mode'] ?? DEFAULT_RETOUCH.mode;
  if (!RETOUCH_MODES.some(([m]) => m === mode)) throw new Error('paintStroke: unknown Blur, Sharpen or Smudge mode');
  const strength = o['strength'] ?? DEFAULT_RETOUCH.strength;
  if (typeof strength !== 'number' || !(strength >= 0 && strength <= 1))
    throw new Error('paintStroke: strength must be 0–1');
  return {
    mode: mode as RetouchMode,
    strength,
    sampleAllLayers: o['sampleAllLayers'] === true,
    ...(kind === 'sharpen' ? { protectDetail: o['protectDetail'] !== false } : {}),
    ...(kind === 'smudge' ? { finger: o['finger'] === true } : {}),
  };
}
