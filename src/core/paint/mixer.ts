/**
 * The Mixer Brush: paint that mixes with the paint already on the canvas.
 *
 * Behaviour (own summary of the reference app):
 * - The brush has a reservoir of paint. Choosing a foreground colour (or Load Brush)
 *   fills it with that colour; Alt/Option-click fills it with the image under the tip
 *   (only its average colour with Load Solid Colors Only). Clean Brush empties it.
 * - Wet: how much paint the brush takes up from the canvas. At 0 % it lays down the
 *   reservoir's paint only, like the Brush; higher, the canvas colours mix in and are
 *   dragged along the stroke.
 * - Load: how much paint the reservoir holds; with little, strokes run dry quickly.
 * - Mix: the share of canvas paint in what the brush lays down (the rest from the
 *   reservoir); it only applies while Wet is above 0.
 * - Flow: how much paint each dab lays down.
 * - Load the brush after each stroke / Clean the brush after each stroke: refill the
 *   reservoir, or empty the brush of all paint, after every stroke. Otherwise the brush
 *   keeps what it holds, colours taken up from the canvas included, into the next stroke.
 * - Sample All Layers: the canvas paint is what the visible layers show together;
 *   the paint still goes on the active layer.
 * - Useful combinations set Wet, Load and Mix together.
 * - It has no blend mode and no opacity.
 *
 * Model (ours; docs/FORMAT_NOTES.md §15). Per dab, per pixel under the tip (coverage
 * c, premultiplied colours 0–1): the brush's paint mixes reservoir paint R, weighted
 * level × (1 − Mix) × R's alpha, with the canvas paint P it holds, weighted
 * Wet × (level × Mix + 1 − level); the pixel moves towards that paint by
 * Flow × c × min(1, reservoir weight × (1 − Wet/2) + pickup weight). The brush then
 * takes up the canvas there: P moves towards the pixel by c × Wet. P is kept per
 * pixel of the tip and travels with it, which drags colours along. The reservoir's
 * level falls with the distance painted, faster with less Load and more Flow. With
 * paint symmetry each mirror image has its own brush.
 *
 * What a stroke starts with (reservoir, level, the paint the brush holds) is recorded
 * with it, as 16-bit samples (32-bit floats in 32-bit documents), so a replay paints
 * exactly the same.
 */
import { base64ToBytes, bytesToBase64 } from '../base64';
import { flatten, type FlattenPlan } from '../composite/flatten';
import type { Rect } from '../document/geometry';
import type { BitDepth, ColorMode } from '../document/pixel-format';
import { TILE_SIZE, tileIndex, tileKey } from '../document/tile';
import { averageColor, sampledToRgb } from './sample';
import { dabBounds, type BrushSettings, type Dab } from './brush';
import { DabPainter } from './dab-painter';
import type { StrokeSetup } from './stroke';
import { addNoise } from './texture';

export interface MixerOptions {
  /** How much paint the brush takes up from the canvas, 0–1. */
  wet: number;
  /** How much paint the reservoir holds, 0.01–1. */
  load: number;
  /** The share of canvas paint in the paint laid down, 0–1 (only while Wet is above 0). */
  mix: number;
  /** The canvas paint is what all visible layers show. */
  sampleAllLayers: boolean;
  /** Refill the reservoir after every stroke. */
  loadAfterStroke: boolean;
  /** Empty the brush after every stroke. */
  cleanAfterStroke: boolean;
  /** Alt-click loads the average colour under the tip instead of the image. */
  solidOnly: boolean;
}

export const DEFAULT_MIXER: Readonly<MixerOptions> = Object.freeze({
  wet: 1,
  load: 0.5,
  mix: 0.5,
  sampleAllLayers: false,
  loadAfterStroke: true,
  cleanAfterStroke: true,
  solidOnly: false,
});

export interface MixerCombination {
  id: string;
  label: string;
  wet: number;
  load: number;
  mix: number;
}

/**
 * Useful combinations: four states of the paint (dry, moist, wet, very wet), each as is and
 * with a light or heavy load, and the wet states with a light or heavy mix. Our own values.
 */
export const MIXER_COMBINATIONS: readonly MixerCombination[] = (() => {
  const states: [string, string, number][] = [
    ['dry', 'Dry', 0],
    ['moist', 'Moist', 0.1],
    ['wet', 'Wet', 0.5],
    ['very-wet', 'Very Wet', 1],
  ];
  const out: MixerCombination[] = [];
  for (const [id, label, wet] of states) {
    const mix = wet > 0 ? 0.5 : 0;
    out.push({ id, label, wet, load: 0.5, mix });
    out.push({ id: `${id}-light-load`, label: `${label}, Light Load`, wet, load: 0.05, mix });
    out.push({ id: `${id}-heavy-load`, label: `${label}, Heavy Load`, wet, load: 1, mix });
    if (wet > 0) {
      out.push({ id: `${id}-light-mix`, label: `${label}, Light Mix`, wet, load: 0.5, mix: 0.2 });
      out.push({ id: `${id}-heavy-mix`, label: `${label}, Heavy Mix`, wet, load: 0.5, mix: 1 });
    }
  }
  return out;
})();

/** The combination whose values the options have, or 'custom'. */
export function mixerCombination(o: Pick<MixerOptions, 'wet' | 'load' | 'mix'>): string {
  const same = (a: number, b: number) => Math.abs(a - b) < 0.005;
  return (
    MIXER_COMBINATIONS.find((c) => same(c.wet, o.wet) && same(c.load, o.load) && (o.wet === 0 || same(c.mix, o.mix)))
      ?.id ?? 'custom'
  );
}

/**
 * How far (in diameters) the reservoir paints before it is down to about a third: grows steeply
 * with Load; at 100 % it never runs dry.
 */
export function runLength(load: number): number {
  if (load >= 1) return Infinity;
  const l = Math.max(0.01, load);
  return (20 * l) / (1.02 - l);
}

// ---------------------------------------------------------------------------
// Paint as recorded data
// ---------------------------------------------------------------------------

/**
 * A picture of paint for descriptors: premultiplied colour channels then alpha per pixel,
 * as 16-bit values (`u16`, 0–1) or 32-bit floats (`f32`), little-endian, base64. A pickup
 * also says which of its pixels hold paint (`filled`, one byte each).
 */
export interface EncodedPaint {
  width: number;
  height: number;
  /** Values per pixel (colour channels + alpha). */
  channels: number;
  encoding: 'u16' | 'f32';
  data: string;
  filled?: string;
}

/** Paint as the renderer holds it: premultiplied, `channels` values per pixel. */
export interface PaintPicture {
  width: number;
  height: number;
  channels: number;
  data: Float32Array;
  filled?: Uint8Array;
}

/** The encoding for a document's depth: floats in 32-bit (values may exceed 1), else 16-bit. */
export const paintEncoding = (depth: BitDepth): 'u16' | 'f32' => (depth === 32 ? 'f32' : 'u16');

export function encodePaint(p: PaintPicture, encoding: 'u16' | 'f32'): EncodedPaint {
  const n = p.data.length;
  const bytes = new Uint8Array(n * (encoding === 'u16' ? 2 : 4));
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) {
    const v = p.data[i]!;
    if (encoding === 'u16') view.setUint16(i * 2, Math.round(Math.min(1, Math.max(0, v)) * 65535), true);
    else view.setFloat32(i * 4, v, true);
  }
  return {
    width: p.width,
    height: p.height,
    channels: p.channels,
    encoding,
    data: bytesToBase64(bytes),
    ...(p.filled ? { filled: bytesToBase64(p.filled) } : {}),
  };
}

export function decodePaint(e: EncodedPaint): PaintPicture {
  const n = e.width * e.height * e.channels;
  const bytes = base64ToBytes(e.data);
  const size = e.encoding === 'u16' ? 2 : 4;
  if (bytes.length !== n * size) throw new Error('Mixer Brush: the recorded paint has the wrong size');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = size === 2 ? view.getUint16(i * 2, true) / 65535 : view.getFloat32(i * 4, true);
  let filled: Uint8Array | undefined;
  if (e.filled !== undefined) {
    filled = base64ToBytes(e.filled);
    if (filled.length !== e.width * e.height) throw new Error('Mixer Brush: the recorded paint has the wrong size');
  }
  return { width: e.width, height: e.height, channels: e.channels, data, ...(filled ? { filled } : {}) };
}

/** One colour of paint (colour samples 0–1, straight), opaque. */
export function solidPaint(color: readonly number[], encoding: 'u16' | 'f32'): EncodedPaint {
  return encodePaint(
    { width: 1, height: 1, channels: color.length + 1, data: Float32Array.from([...color, 1]) },
    encoding,
  );
}

/** Bytes a recorded stroke's paint takes (for the History's memory budget). */
export function mixerBytes(m: MixerStroke): number {
  return (m.reservoir?.data.length ?? 0) + (m.pickup?.data.length ?? 0) + (m.pickup?.filled?.length ?? 0);
}

// ---------------------------------------------------------------------------
// Strokes
// ---------------------------------------------------------------------------

/** A Mixer Brush stroke's settings and what the brush holds as it starts (recorded with the stroke). */
export interface MixerStroke {
  wet: number;
  load: number;
  mix: number;
  sampleAllLayers: boolean;
  /** The reservoir's paint: 1 × 1 for one colour, else a picture spread across the tip; null when empty. */
  reservoir: EncodedPaint | null;
  /** How full the reservoir is, 0–1. */
  level: number;
  /** Paint the brush took up in earlier strokes (a square around the tip's centre), or null when clean. */
  pickup: EncodedPaint | null;
}

/** What the brush holds when a stroke ends (the stroke's own brush, not its mirror images'). */
export interface MixerEnd {
  level: number;
  pickup: EncodedPaint | null;
}

/** The renderer's part of a Mixer Brush stroke (StrokeSetup.mixer). */
export interface MixerSetup extends MixerStroke {
  /** Side of the square of paint the brush holds (odd), large enough for its largest dab. */
  side: number;
  /** The brush's spacing (share of the diameter): how far a dab that did not move counts as painting. */
  spacing: number;
  /** Sample All Layers: the image under the active layer, and the layer's opacity × fill. */
  below: FlattenPlan | null;
  layerOpacity: number;
}

/** The side of the brush's square of paint for a brush (`sampled`: its tip is an image). */
export function pickupSide(brush: BrushSettings, sampled: boolean): number {
  const sh = brush.dynamics?.shape;
  const grow = sh?.enabled && sh.size.control === 'tilt' ? 1 + sh.tiltScale : 1;
  const radius = ((brush.size * grow) / 2) * (sampled ? Math.SQRT2 : 1) + 2;
  return 2 * Math.ceil(radius) + 1;
}

/** What the Mixer Brush tool holds between strokes. */
export interface MixerBrushState {
  /** What loading fills the reservoir with. */
  load: MixerLoad;
  /** How full the reservoir is: 0 (empty, a clean brush) – 1. */
  level: number;
  /** Paint taken up in earlier strokes (when the brush is not cleaned after each one), with its document's mode. */
  pickup: { mode: ColorMode; paint: EncodedPaint } | null;
}

/** The foreground colour, or paint taken from an image (Alt-click) with a small picture for the options bar. */
export type MixerLoad =
  { kind: 'foreground' } | { kind: 'sample'; mode: ColorMode; paint: EncodedPaint; preview: MixerPreview };

/** 8-bit RGBA rows, for showing the brush's paint. */
export interface MixerPreview {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** What the Mixer Brush holds at first: the foreground colour. */
export const INITIAL_MIXER: Readonly<MixerBrushState> = Object.freeze({
  load: { kind: 'foreground' } as const,
  level: 1,
  pickup: null,
});

/**
 * A stroke's start from what the tool holds, for a document: paint taken from an image of
 * another colour mode gives way to the foreground colour (`foreground`: samples 0–1), and
 * a pickup from another mode is dropped.
 */
export function mixerStroke(
  state: MixerBrushState,
  options: MixerOptions,
  doc: { mode: ColorMode; colorChannels: number; depth: BitDepth },
  foreground: readonly number[],
): MixerStroke {
  const channels = doc.colorChannels + 1;
  const load = state.load;
  const sample = load.kind === 'sample' && load.mode === doc.mode && load.paint.channels === channels ? load : null;
  const pickup =
    state.pickup && state.pickup.mode === doc.mode && state.pickup.paint.channels === channels
      ? state.pickup.paint
      : null;
  return {
    wet: options.wet,
    load: options.load,
    mix: options.mix,
    sampleAllLayers: options.sampleAllLayers,
    reservoir: state.level > 0 ? (sample?.paint ?? solidPaint(foreground, paintEncoding(doc.depth))) : null,
    level: state.level > 0 ? Math.min(1, state.level) : 0,
    pickup,
  };
}

/** What the tool holds after a stroke: what the brush ended with, then cleaned and/or reloaded as the options say. */
export function afterStroke(
  state: MixerBrushState,
  end: MixerEnd | null,
  mode: ColorMode,
  options: Pick<MixerOptions, 'loadAfterStroke' | 'cleanAfterStroke'>,
): MixerBrushState {
  let level = end ? end.level : state.level;
  let pickup = end ? (end.pickup ? { mode, paint: end.pickup } : null) : state.pickup;
  if (options.cleanAfterStroke) {
    level = 0;
    pickup = null;
  }
  if (options.loadAfterStroke) level = 1;
  return { load: state.load, level, pickup };
}

// ---------------------------------------------------------------------------
// Rendering (in the pixel worker)
// ---------------------------------------------------------------------------

/** The paint one brush (the stroke's, or a mirror image's) holds. */
interface HeldPaint {
  level: number;
  /** Canvas paint taken up, per pixel of a side × side square centred on the tip. */
  pickup: Float32Array;
  filled: Uint8Array;
  /** Where its last dab was (null before the first). */
  last: { x: number; y: number } | null;
}

/** How much wet canvas paint thins the reservoir's paint laid over it (at Wet 100 %). */
const WET_THINNING = 0.5;
/** The share of the canvas paint the brush carries that one pass leaves on the canvas (at Flow 100 %). */
const CARRIED_DEPOSIT = 0.85;
/** The share of the canvas under it the brush takes up in one pass (while Wet is above 0). */
const PICKUP = 0.5;
/** How much of a pass a stroke's first dab counts as (a click lays down a dab you can see). */
const FIRST_DAB = 0.5;

export class MixerRenderer extends DabPainter {
  readonly #m: MixerSetup;
  readonly #reservoir: PaintPicture | null;
  readonly #start: PaintPicture | null;
  readonly #side: number;
  readonly #half: number;
  readonly #held = new Map<number, HeldPaint>();
  // Scratch, one pixel each.
  readonly #layer: Float32Array;
  readonly #canvas: Float32Array;
  readonly #res: Float32Array;
  readonly #out: Float32Array;

  constructor(setup: StrokeSetup) {
    const m = setup.mixer;
    if (!m) throw new Error('Mixer Brush: the stroke has no mixer settings');
    super(setup, m.below, m.layerOpacity);
    this.#m = m;
    const fits = (p: PaintPicture) => p.channels === this.n;
    const reservoir = m.reservoir ? decodePaint(m.reservoir) : null;
    if (reservoir && !fits(reservoir)) throw new Error('Mixer Brush: the paint does not fit the layer');
    this.#reservoir = reservoir;
    const start = m.pickup ? decodePaint(m.pickup) : null;
    if (start && (!fits(start) || !start.filled || start.width !== start.height || start.width % 2 !== 1))
      throw new Error('Mixer Brush: the paint the brush holds does not fit the layer');
    this.#start = start;
    this.#side = Math.max(1, m.side | 1);
    this.#half = (this.#side - 1) / 2;
    this.#layer = new Float32Array(this.n);
    this.#canvas = new Float32Array(this.n);
    this.#res = new Float32Array(this.n);
    this.#out = new Float32Array(this.n);
  }

  /** The paint a brush holds (made from what the stroke started with). */
  #brush(copy: number): HeldPaint {
    let held = this.#held.get(copy);
    if (held) return held;
    const side = this.#side;
    const n = this.n;
    const pickup = new Float32Array(side * side * n);
    const filled = new Uint8Array(side * side);
    const start = this.#start;
    if (start) {
      // Centred in this stroke's square (cut down or padded with nothing held).
      const d = (side - start.width) / 2;
      for (let j = 0; j < start.width; j++) {
        const y = j + d;
        if (y < 0 || y >= side) continue;
        for (let i = 0; i < start.width; i++) {
          const x = i + d;
          if (x < 0 || x >= side) continue;
          const from = j * start.width + i;
          const to = y * side + x;
          filled[to] = start.filled![from]!;
          for (let c = 0; c < n; c++) pickup[to * n + c] = start.data[from * n + c]!;
        }
      }
    }
    held = { level: this.#reservoir ? this.#m.level : 0, pickup, filled, last: null };
    this.#held.set(copy, held);
    return held;
  }

  /** The reservoir's paint at offset (dx, dy) from a dab's centre (document px), premultiplied, into `out`. */
  #reservoirAt(dab: Dab, dx: number, dy: number, out: Float32Array): void {
    const r = this.#reservoir!;
    const n = this.n;
    if (r.width === 1 && r.height === 1) {
      for (let c = 0; c < n; c++) out[c] = r.data[c]!;
      return;
    }
    // The picture spans the tip's diameter; bilinear, nothing outside it.
    const u = (dx / dab.size) * r.width + r.width / 2 - 0.5;
    const v = (dy / dab.size) * r.height + r.height / 2 - 0.5;
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const fx = u - x0;
    const fy = v - y0;
    out.fill(0);
    const add = (x: number, y: number, w: number) => {
      if (w <= 0 || x < 0 || y < 0 || x >= r.width || y >= r.height) return;
      const o = (y * r.width + x) * n;
      for (let c = 0; c < n; c++) out[c] = out[c]! + r.data[o + c]! * w;
    };
    add(x0, y0, (1 - fx) * (1 - fy));
    add(x0 + 1, y0, fx * (1 - fy));
    add(x0, y0 + 1, (1 - fx) * fy);
    add(x0 + 1, y0 + 1, fx * fy);
  }

  /** Paints dabs (document coordinates) in order. Returns the keys of the tiles that changed. */
  applyDabs(dabs: readonly Dab[]): Set<number> {
    const changed = new Set<number>();
    const s = this.setup;
    const m = this.#m;
    const n = this.n;
    const cc = this.cc;
    const side = this.#side;
    const half = this.#half;
    const tip = this.tip;
    const L = this.#layer;
    const C = this.#canvas;
    const R = this.#res;
    const O = this.#out;
    for (const dab of dabs) {
      if (dab.dual) continue; // the Dual Brush does not apply
      const held = this.#brush(dab.copy ?? 0);
      const wet = Math.min(1, Math.max(0, dab.wet ?? m.wet));
      const mix = wet > 0 ? Math.min(1, Math.max(0, dab.mix ?? m.mix)) : 0;
      const flow = Math.min(1, Math.max(0, s.flow * dab.strength));
      const level = this.#reservoir ? held.level : 0;
      // How much of the brush's paint comes from the reservoir and from the canvas paint it holds.
      const wr = level * (1 - mix);
      const wp = wet * (level * mix + (1 - level));
      // How far this dab moves the brush (in diameters): what one dab adds is the share of one
      // pass of the whole tip, so the result does not depend on the spacing. The first dab (a
      // click) counts as half a pass; one that did not move as one spacing step.
      const last = held.last;
      const moved = last ? Math.hypot(dab.x - last.x, dab.y - last.y) / dab.size : FIRST_DAB;
      const step = Math.min(1, Math.max(0.01, moved > 0 ? moved : m.spacing));
      const pickLog = Math.log(1 - PICKUP);
      // One colour in the reservoir (the usual case): the paint and how much one pass lays down are
      // the same everywhere under the tip, and what a dab adds depends on the tip's coverage only.
      const solid = !!this.#reservoir && this.#reservoir.width === 1 && this.#reservoir.height === 1;
      if (solid && wr > 0) this.#reservoirAt(dab, 0, 0, R);
      const solidWr = solid ? wr * R[cc]! : 0;
      const solidPass =
        solidWr + wp > 0 ? flow * Math.min(1, solidWr * (1 - wet * WET_THINNING) + wp * CARRIED_DEPOSIT) : 0;
      let lastCov = -1;
      let covK = 0;
      let covRate = 0;
      const shape = this.shape(dab);
      const cx = Math.floor(dab.x);
      const cy = Math.floor(dab.y);
      const b = dabBounds(dab, tip !== null);
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
              const dx = x + 0.5 - dab.x;
              let cov = shape.at(dx, dy);
              if (cov <= 0 || !this.inCanvas(x, y)) continue;
              if (s.noise) cov = addNoise(cov, x, y);
              if (cov <= 0) continue;
              const p = (ly - ty * TILE_SIZE) * TILE_SIZE + (lx - tx * TILE_SIZE);
              const i = p * this.spp;
              this.read(tile.data, i, L);
              this.canvasAt(L, tile.below, p, C);
              const gx = x - cx + half;
              const g = gx >= 0 && gx < side && gy >= 0 && gy < side ? gy * side + gx : -1;
              // The canvas paint the brush holds here (taken up now where it holds none yet).
              let P: Float32Array = C;
              let po = 0;
              if (g >= 0 && wet > 0) {
                if (!held.filled[g]) {
                  held.pickup.set(C, g * n);
                  held.filled[g] = 1;
                }
                P = held.pickup;
                po = g * n;
              } else if (g >= 0 && held.filled[g]) {
                P = held.pickup;
                po = g * n;
              }
              const sel = this.selected(tile, p);
              if (cov !== lastCov) {
                lastCov = cov;
                covK = solid || wr <= 0 ? dabShare(solidPass, cov, step) : 0;
                covRate = wet > 0 ? 1 - Math.exp(pickLog * cov * step) : 0;
              }
              let ra = 0;
              if (wr > 0) {
                if (!solid) this.#reservoirAt(dab, dx, dy, R);
                ra = R[cc]!;
              }
              const wrPx = wr * ra;
              const total = wrPx + wp;
              // One pass lays down `pass` of the brush's paint; this dab its share.
              let k = covK;
              if (!solid && wr > 0) {
                const pass = total > 0 ? flow * Math.min(1, wrPx * (1 - wet * WET_THINNING) + wp * CARRIED_DEPOSIT) : 0;
                k = dabShare(pass, cov, step);
              }
              k *= sel;
              if (k > 0) {
                const alphaBefore = L[cc]!;
                for (let c = 0; c < cc; c++) {
                  const paint = (wr * (wrPx > 0 ? R[c]! : 0) + wp * P[po + c]!) / total;
                  O[c] = L[c]! + (paint - L[c]!) * k;
                }
                const paintAlpha = (wrPx + wp * P[po + cc]!) / total;
                O[cc] = L[cc]! + (paintAlpha - L[cc]!) * k;
                this.write(tile, i, O, alphaBefore);
                any = true;
              }
              if (wet > 0 && g >= 0) {
                // Taking up the canvas as it is now.
                if (k > 0) {
                  this.read(tile.data, i, L);
                  this.canvasAt(L, tile.below, p, C);
                }
                const rate = covRate;
                const o = g * n;
                for (let c = 0; c < n; c++)
                  held.pickup[o + c] = held.pickup[o + c]! + (C[c]! - held.pickup[o + c]!) * rate;
              }
            }
          }
          if (any) changed.add(tileKey(tx, ty));
        }
      }
      // The reservoir runs dry with the distance painted (in diameters, at most one per dab).
      if (this.#reservoir && held.level > 0) {
        held.level *= Math.exp(-(step * flow * (1 - mix)) / runLength(m.load));
      }
      held.last = { x: dab.x, y: dab.y };
    }
    return changed;
  }

  /** What the stroke's own brush holds now. */
  mixerEnd(): MixerEnd {
    const held = this.#held.get(0);
    if (!held) return { level: this.#reservoir ? this.#m.level : 0, pickup: this.#m.pickup };
    const any = held.filled.some((f) => f !== 0);
    return {
      level: held.level,
      pickup: any
        ? encodePaint(
            { width: this.#side, height: this.#side, channels: this.n, data: held.pickup, filled: held.filled },
            paintEncoding(this.setup.format.depth),
          )
        : null,
    };
  }
}

/**
 * What one dab lays down of the brush's paint, as its share of a pass laying down `pass`: full
 * paint where the tip is solid and a pass lays down all, soft edges as from a pass just short of it.
 */
function dabShare(pass: number, cov: number, step: number): number {
  if (pass <= 0) return 0;
  if (pass >= 0.999 && cov >= 1) return 1;
  return 1 - Math.exp(Math.log(1 - Math.min(0.999, pass)) * cov * step);
}

// ---------------------------------------------------------------------------
// Loading from the image (Alt-click)
// ---------------------------------------------------------------------------

/** Largest side of paint taken from an image (larger areas are averaged down to it). */
export const MAX_LOAD_SIDE = 256;
const PREVIEW_SIDE = 48;

/**
 * Paint taken from `rect` of the image `plan` shows (only within `canvas`): the picture,
 * averaged down to at most MAX_LOAD_SIDE on a side, or with `solid` its average colour.
 */
export function sampleMixerLoad(
  plan: FlattenPlan,
  rect: Rect,
  canvas: Rect,
  solid: boolean,
): { paint: EncodedPaint; preview: MixerPreview } {
  const n = plan.colorChannels + 1;
  const encoding = paintEncoding(plan.depth);
  const full = new Float32Array(rect.w * rect.h * n);
  const x0 = Math.max(rect.x, canvas.x);
  const y0 = Math.max(rect.y, canvas.y);
  const x1 = Math.min(rect.x + rect.w, canvas.x + canvas.w);
  const y1 = Math.min(rect.y + rect.h, canvas.y + canvas.h);
  if (x1 > x0 && y1 > y0) {
    const part = flatten(plan, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    for (let y = y0; y < y1; y++)
      full.set(
        part.data.subarray((y - y0) * (x1 - x0) * n, (y - y0 + 1) * (x1 - x0) * n),
        ((y - rect.y) * rect.w + (x0 - rect.x)) * n,
      );
  }
  if (solid) {
    const avg = averageColor({ rect, colorChannels: plan.colorChannels, data: full });
    const paint = avg
      ? solidPaint(avg, encoding)
      : encodePaint({ width: 1, height: 1, channels: n, data: new Float32Array(n) }, encoding);
    return { paint, preview: previewOf(decodePaint(paint), plan.mode, plan.depth) };
  }
  // Averaged down (premultiplied) to the stored size.
  const w = Math.min(MAX_LOAD_SIDE, rect.w);
  const h = Math.min(MAX_LOAD_SIDE, rect.h);
  const data = new Float32Array(w * h * n);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * rect.h) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * rect.h) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * rect.w) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * rect.w) / w));
      const o = (y * w + x) * n;
      const count = (sy1 - sy0) * (sx1 - sx0);
      for (let sy = sy0; sy < sy1; sy++)
        for (let sx = sx0; sx < sx1; sx++) {
          const f = (sy * rect.w + sx) * n;
          for (let c = 0; c < n; c++) data[o + c] = data[o + c]! + full[f + c]! / count;
        }
    }
  }
  const picture = { width: w, height: h, channels: n, data };
  const paint = encodePaint(picture, encoding);
  return { paint, preview: previewOf(decodePaint(paint), plan.mode, plan.depth) };
}

/** A small RGBA picture of paint (nearest pixels). */
export function previewOf(p: PaintPicture, mode: ColorMode, depth: BitDepth): MixerPreview {
  const width = Math.min(PREVIEW_SIDE, p.width);
  const height = Math.min(PREVIEW_SIDE, p.height);
  const rgba = new Uint8Array(width * height * 4);
  const n = p.channels;
  const straight: number[] = new Array<number>(n - 1).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (Math.floor((y * p.height) / height) * p.width + Math.floor((x * p.width) / width)) * n;
      const a = p.data[o + n - 1]!;
      for (let c = 0; c < n - 1; c++) straight[c] = a > 0 ? p.data[o + c]! / a : 0;
      const rgb = sampledToRgb(straight, mode, depth);
      const d = (y * width + x) * 4;
      rgba[d] = Math.round(rgb.r * 255);
      rgba[d + 1] = Math.round(rgb.g * 255);
      rgba[d + 2] = Math.round(rgb.b * 255);
      rgba[d + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Reading recorded strokes
// ---------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parsePaint(v: unknown, channels: number, pickup: boolean): EncodedPaint {
  const o = v as Partial<EncodedPaint> | null;
  if (!o || typeof o !== 'object') throw new Error('paintStroke: the Mixer Brush paint must be a picture');
  const side = (k: unknown) => Number.isInteger(k) && (k as number) >= 1 && (k as number) <= 16384;
  if (!side(o.width) || !side(o.height)) throw new Error('paintStroke: the Mixer Brush paint needs a size');
  if (o.channels !== channels) throw new Error('paintStroke: the Mixer Brush paint does not fit the document');
  if (o.encoding !== 'u16' && o.encoding !== 'f32') throw new Error('paintStroke: unknown Mixer Brush paint encoding');
  if (typeof o.data !== 'string') throw new Error('paintStroke: the Mixer Brush paint needs its data');
  if (pickup && (typeof o.filled !== 'string' || o.width !== o.height || o.width! % 2 !== 1))
    throw new Error('paintStroke: the paint the Mixer Brush holds must be an odd square with its filled pixels');
  return {
    width: o.width!,
    height: o.height!,
    channels,
    encoding: o.encoding,
    data: o.data,
    ...(pickup ? { filled: o.filled! } : {}),
  };
}

/** A recorded Mixer Brush stroke's settings and start, checked (`colorChannels`: the document's). */
export function parseMixerStroke(v: unknown, colorChannels: number): MixerStroke {
  const o = (v ?? {}) as Record<string, unknown>;
  const num = (key: string, lo: number, hi: number, fallback: number) => {
    const x = o[key] ?? fallback;
    if (!isNum(x) || x < lo || x > hi) throw new Error(`paintStroke: Mixer Brush ${key} must be ${lo}–${hi}`);
    return x;
  };
  const channels = colorChannels + 1;
  return {
    wet: num('wet', 0, 1, DEFAULT_MIXER.wet),
    load: num('load', 0.01, 1, DEFAULT_MIXER.load),
    mix: num('mix', 0, 1, DEFAULT_MIXER.mix),
    sampleAllLayers: o['sampleAllLayers'] === true,
    reservoir:
      o['reservoir'] === null || o['reservoir'] === undefined ? null : parsePaint(o['reservoir'], channels, false),
    level: num('level', 0, 1, 1),
    pickup: o['pickup'] === null || o['pickup'] === undefined ? null : parsePaint(o['pickup'], channels, true),
  };
}
