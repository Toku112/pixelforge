/**
 * Renders brush and eraser strokes into layer tiles (runs in the pixel worker).
 *
 * Every touched tile keeps a copy of its pixels from before the stroke and a
 * coverage buffer. Each dab adds `flow × strength × tip` to the coverage
 * (building up: c ← c + (1 − c)·a), and the pixel is recomputed from its original
 * value with the stroke's coverage limited by Opacity and the selection — so one
 * stroke never exceeds Opacity however often it crosses itself, as in the
 * reference app.
 *
 * - Brush: paints the colour into the pixel with the brush Mode (a blend mode,
 *   computed like a layer of paint over the pixel; Behind paints under existing
 *   pixels; Clear erases). With locked transparency, or on a layer without alpha,
 *   only the colour changes.
 * - Eraser: lowers alpha; on a layer without alpha or with locked transparency it
 *   paints the background colour instead.
 * - Tips: the computed round/elliptical tip, or a sampled tip read bilinearly from
 *   a pyramid of halved copies (so small dabs of a large tip stay smooth).
 * - Texture, Dual Brush, Noise and Wet Edges (texture.ts): Noise and Texture Each
 *   Tip change what each dab adds; the dual tip's dabs build a coverage of their own
 *   that masks the stroke's; Texture (whole stroke) and Wet Edges then shape the
 *   stroke's coverage before Opacity limits it.
 */
import { blendChannel, blendColor, dissolveNoise, isWholeColorMode } from '../composite/blend';
import type { Rect } from '../document/geometry';
import { maxSampleValue, samplesPerPixel, type PixelFormat, type SampleArray } from '../document/pixel-format';
import { TILE_SIZE, tileIndex, tileKey } from '../document/tile';
import { MaskReader } from '../selection/mask-ops';
import type { MaskData } from '../selection/selection';
import type { PatternPixels } from '../pattern/pattern';
import { dabBounds, dabCoverage, type BrushMode, type Dab } from './brush';
import {
  WET_RIM,
  addNoise,
  applyTexture,
  combineDual,
  textureLut,
  wetEdge,
  type DualMode,
  type TextureMode,
} from './texture';

type TipData = { width: number; height: number; data: Uint8Array };

/** Brush Texture as the renderer needs it (the pattern as gray levels). */
export interface StrokeTexture {
  width: number;
  height: number;
  /** Gray levels 0–255, row by row. */
  gray: Uint8Array;
  scale: number;
  brightness: number;
  contrast: number;
  invert: boolean;
  eachTip: boolean;
  mode: TextureMode;
  depth: number;
}

export interface StrokeSetup {
  format: PixelFormat;
  /** Colour samples painted (the brush colour, or the background colour for erasing opaque layers). */
  color: number[];
  erase: boolean;
  opacity: number;
  flow: number;
  hardness: number;
  /** How paint combines with the pixels (brush only). */
  mode: BrushMode;
  /** A sampled tip (coverage 0–255), or null for the computed round tip. */
  tip: TipData | null;
  /** Hard pixels only: a pixel is painted fully where the tip covers at least half of it, else not at all. */
  aliased?: boolean;
  /** Brush Texture, when on. */
  texture?: StrokeTexture | null;
  /** Dual Brush, when on: its tip (null: round, of `hardness`) and how it masks the stroke. */
  dual?: { tip: TipData | null; hardness: number; mode: DualMode } | null;
  noise?: boolean;
  wetEdges?: boolean;
  /** Dabs carry their own colours (Color Dynamics) / opacities (Transfer): keep them per pixel. */
  varyColor?: boolean;
  /** Pattern Stamp: paints a pattern instead of `color`. */
  pattern?: StrokePattern | null;
  varyOpacity?: boolean;
  /** Transparency of the layer is locked: alpha never changes. */
  lockAlpha: boolean;
  /** The layer's position in the document. */
  offsetX: number;
  offsetY: number;
  /** Painting is limited to the selection, when there is one. */
  selection: { mask: MaskData; canvas: Rect } | null;
}

/** The Pattern Stamp's pattern. */
export interface StrokePattern extends PatternPixels {
  /** Where the pattern starts repeating (document coordinates): 0, 0 when Aligned, else where the stroke began. */
  originX: number;
  originY: number;
  /** Each dab paints one colour: the pattern's at the dab's centre (needs `varyColor`). */
  impressionist: boolean;
}

interface TileState {
  tx: number;
  ty: number;
  data: SampleArray;
  original: SampleArray;
  coverage: Float32Array;
  /** Colour of the paint so far per pixel (varied colours only). */
  paint: Float32Array | null;
  /** Highest dab opacity that reached each pixel (varied opacities only). */
  cap: Float32Array | null;
  /** Coverage of the dual tip's dabs (Dual Brush only). */
  dual: Float32Array | null;
  /** Texture value 0–1 at each pixel (Texture only). */
  texture: Float32Array | null;
  /** Coverage of the dabs shrunk by the wet rim (Wet Edges only): what is interior. */
  inner: Float32Array | null;
  /** Selection under the tile: per-pixel values, or uniform 0 / 255. */
  selection: Uint8Array | 0 | 255;
}

/** A sampled tip as a pyramid: level 0 is the tip (0–1), each next level half the size. */
interface TipPyramid {
  levels: { w: number; h: number; data: Float32Array }[];
  /** The tip's longer side at level 0. */
  side: number;
}

function buildPyramid(tip: TipData): TipPyramid {
  const first = new Float32Array(tip.width * tip.height);
  for (let i = 0; i < first.length; i++) first[i] = tip.data[i]! / 255;
  const levels = [{ w: tip.width, h: tip.height, data: first }];
  for (;;) {
    const prev = levels.at(-1)!;
    if (prev.w <= 2 && prev.h <= 2) break;
    const w = Math.max(1, Math.ceil(prev.w / 2));
    const h = Math.max(1, Math.ceil(prev.h / 2));
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const sx = x * 2 + dx;
            const sy = y * 2 + dy;
            if (sx < prev.w && sy < prev.h) {
              sum += prev.data[sy * prev.w + sx]!;
              n++;
            }
          }
        data[y * w + x] = sum / n;
      }
    }
    levels.push({ w, h, data });
  }
  return { levels, side: Math.max(tip.width, tip.height) };
}

/** Bilinear sample of a pyramid level at (u, v) in level pixels (centres at +0.5); 0 outside. */
function sampleLevel(level: { w: number; h: number; data: Float32Array }, u: number, v: number): number {
  const x = u - 0.5;
  const y = v - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (i: number, j: number) =>
    i < 0 || j < 0 || i >= level.w || j >= level.h ? 0 : level.data[j * level.w + i]!;
  return (
    at(x0, y0) * (1 - fx) * (1 - fy) +
    at(x0 + 1, y0) * fx * (1 - fy) +
    at(x0, y0 + 1) * (1 - fx) * fy +
    at(x0 + 1, y0 + 1) * fx * fy
  );
}

export class StrokeRenderer {
  readonly #setup: StrokeSetup;
  readonly #tiles = new Map<number, TileState>();
  readonly #reader: MaskReader | null;
  readonly #spp: number;
  readonly #max: number;
  readonly #tip: TipPyramid | null;
  readonly #dualTip: TipPyramid | null;
  /** The texture's values 0–1 after Brightness, Contrast and Invert (Texture only). */
  readonly #texture: Float32Array | null;
  readonly #q: (v: number) => number;
  readonly #hdr: boolean;
  /** Scratch: the blended paint colour of the pixel being shaded. */
  readonly #blended = [0, 0, 0, 0];
  readonly #paintScratch = [0, 0, 0, 0];
  /** The Pattern Stamp's pattern in sample values (alpha 0–1), or null. */
  readonly #pattern: Float32Array | null;
  readonly #patternColor: number[] = [];

  constructor(setup: StrokeSetup) {
    this.#setup = setup;
    this.#spp = samplesPerPixel(setup.format);
    this.#max = maxSampleValue(setup.format.depth);
    this.#reader = setup.selection ? new MaskReader(setup.selection.mask) : null;
    this.#tip = setup.tip ? buildPyramid(setup.tip) : null;
    this.#dualTip = setup.dual?.tip ? buildPyramid(setup.dual.tip) : null;
    const tex = setup.texture;
    if (tex) {
      const lut = textureLut(tex.brightness, tex.contrast, tex.invert);
      this.#texture = Float32Array.from(tex.gray, (v) => lut[v]!);
    } else {
      this.#texture = null;
    }
    const max = this.#max;
    const pat = setup.pattern;
    if (pat) {
      const n = setup.format.colorChannels + 1;
      if (pat.data.length !== pat.width * pat.height * n) throw new Error('stroke: the pattern does not fit the layer');
      this.#pattern = Float32Array.from(pat.data, (v, i) => (i % n === n - 1 ? v : v * max));
    } else {
      this.#pattern = null;
    }
    this.#hdr = setup.format.depth === 32;
    this.#q = this.#hdr ? (v) => v : (v) => Math.round(Math.min(max, Math.max(0, v)));
  }

  hasTile(tx: number, ty: number): boolean {
    return this.#tiles.has(tileKey(tx, ty));
  }

  /** Adds a layer tile (layer tile coordinates) the stroke may paint into; `data` is written in place. */
  addTile(tx: number, ty: number, data: SampleArray): void {
    const key = tileKey(tx, ty);
    if (this.#tiles.has(key)) return;
    const s = this.#setup;
    this.#tiles.set(key, {
      tx,
      ty,
      data,
      original: data.slice(),
      coverage: new Float32Array(TILE_SIZE * TILE_SIZE),
      paint: s.varyColor ? new Float32Array(TILE_SIZE * TILE_SIZE * s.format.colorChannels) : null,
      cap: s.varyOpacity ? new Float32Array(TILE_SIZE * TILE_SIZE) : null,
      dual: s.dual ? new Float32Array(TILE_SIZE * TILE_SIZE) : null,
      texture: this.#textureTile(tx, ty),
      inner: s.wetEdges ? new Float32Array(TILE_SIZE * TILE_SIZE) : null,
      selection: this.#reader ? this.#reader.layerTile(s.selection!.canvas, s.offsetX, s.offsetY, tx, ty) : 255,
    });
  }

  /** The texture under a layer tile: fixed to the document, repeated, at its scale (bilinear). */
  #textureTile(tx: number, ty: number): Float32Array | null {
    const values = this.#texture;
    const tex = this.#setup.texture;
    if (!values || !tex) return null;
    const out = new Float32Array(TILE_SIZE * TILE_SIZE);
    const { width: w, height: h, scale } = tex;
    const x0 = tx * TILE_SIZE + this.#setup.offsetX;
    const y0 = ty * TILE_SIZE + this.#setup.offsetY;
    const wrap = (v: number, n: number) => ((v % n) + n) % n;
    for (let y = 0; y < TILE_SIZE; y++) {
      const v = (y0 + y + 0.5) / scale - 0.5;
      const j = Math.floor(v);
      const fy = v - j;
      const r0 = wrap(j, h) * w;
      const r1 = wrap(j + 1, h) * w;
      for (let x = 0; x < TILE_SIZE; x++) {
        const u = (x0 + x + 0.5) / scale - 0.5;
        const i = Math.floor(u);
        const fx = u - i;
        const c0 = wrap(i, w);
        const c1 = wrap(i + 1, w);
        const top = values[r0 + c0]! + (values[r0 + c1]! - values[r0 + c0]!) * fx;
        const bottom = values[r1 + c0]! + (values[r1 + c1]! - values[r1 + c0]!) * fx;
        out[y * TILE_SIZE + x] = top + (bottom - top) * fy;
      }
    }
    return out;
  }

  /** A tip's coverage (0–1) at offset (dx, dy) from a dab's centre (document px); `tip` null = round of `hardness`. */
  #coverage(
    dab: Dab,
    tip: TipPyramid | null,
    hardness: number,
    cos: number,
    sin: number,
    level: number,
    scale: number,
    dx: number,
    dy: number,
  ): number {
    let u = dx * cos - dy * sin;
    let v = dx * sin + dy * cos;
    if (dab.flipX) u = -u;
    if (dab.flipY) v = -v;
    v /= dab.roundness;
    if (!tip) {
      const d = Math.hypot(u, v);
      if (this.#setup.aliased) return d <= dab.size / 2 ? 1 : 0;
      return dabCoverage(d, dab.size / 2, hardness);
    }
    // Document px → tip px at level 0, then at the chosen level.
    const lv = tip.levels[level]!;
    const f = 2 ** level;
    const t0 = tip.levels[0]!;
    const c = sampleLevel(lv, (u / scale + t0.w / 2) / f, (v / scale + t0.h / 2) / f);
    return this.#setup.aliased ? (c >= 0.5 ? 1 : 0) : c;
  }

  /** Paints dabs (document coordinates). Returns the keys of the tiles that changed. */
  applyDabs(dabs: readonly Dab[]): Set<number> {
    const changed = new Set<number>();
    const s = this.#setup;
    const tex = s.texture?.eachTip ? s.texture : null;
    for (const dab of dabs) {
      const dual = dab.dual === true && !!s.dual;
      if (dab.dual && !dual) continue;
      const tip = dual ? this.#dualTip : this.#tip;
      const hardness = dual ? s.dual!.hardness : s.hardness;
      const depth = dab.depth ?? tex?.depth ?? 0;
      const b = dabBounds(dab, tip !== null);
      // In layer coordinates.
      const lx0 = b.x - s.offsetX;
      const ly0 = b.y - s.offsetY;
      const amount = dual ? 1 : Math.min(1, s.flow * dab.strength);
      const a = (dab.angle * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      // Sampled tips: document px per tip px, and the pyramid level that is about one tip px per document px.
      const scale = tip ? dab.size / tip.side : 1;
      const level = tip ? Math.min(tip.levels.length - 1, Math.max(0, Math.floor(Math.log2(1 / scale)))) : 0;
      // Wet Edges: the same dab shrunk by the rim on every side.
      const innerDab = s.wetEdges && !dual ? { ...dab, size: Math.max(0, dab.size * (1 - 2 * WET_RIM) - 2) } : null;
      const innerScale = tip && innerDab ? innerDab.size / tip.side : scale;
      for (let ty = tileIndex(ly0); ty <= tileIndex(ly0 + b.h - 1); ty++) {
        for (let tx = tileIndex(lx0); tx <= tileIndex(lx0 + b.w - 1); tx++) {
          const tile = this.#tiles.get(tileKey(tx, ty));
          if (!tile || tile.selection === 0) continue;
          const x0 = Math.max(lx0, tx * TILE_SIZE);
          const y0 = Math.max(ly0, ty * TILE_SIZE);
          const x1 = Math.min(lx0 + b.w, (tx + 1) * TILE_SIZE);
          const y1 = Math.min(ly0 + b.h, (ty + 1) * TILE_SIZE);
          let any = false;
          for (let ly = y0; ly < y1; ly++) {
            const dy = ly + s.offsetY + 0.5 - dab.y;
            for (let lx = x0; lx < x1; lx++) {
              let cov = this.#coverage(dab, tip, hardness, cos, sin, level, scale, lx + s.offsetX + 0.5 - dab.x, dy);
              if (cov <= 0) continue;
              const p = (ly - ty * TILE_SIZE) * TILE_SIZE + (lx - tx * TILE_SIZE);
              if (dual) {
                const m = tile.dual!;
                m[p] = m[p]! + (1 - m[p]!) * cov;
                if (tile.coverage[p]! > 0) this.#shade(tile, p, lx + s.offsetX, ly + s.offsetY);
                any = true;
                continue;
              }
              if (s.noise) cov = addNoise(cov, lx + s.offsetX, ly + s.offsetY);
              const c = tile.coverage[p]!;
              let add = cov * amount;
              if (tex) add = applyTexture(tex.mode, add, tile.texture![p]!, depth);
              if (add <= 0) continue;
              if (innerDab && innerDab.size > 0) {
                const dx = lx + s.offsetX + 0.5 - dab.x;
                const inner = this.#coverage(innerDab, tip, hardness, cos, sin, level, innerScale, dx, dy) * amount;
                const m = tile.inner!;
                m[p] = m[p]! + (1 - m[p]!) * inner;
              }
              const next = c + (1 - c) * add;
              if (tile.paint) {
                // New paint over the paint so far.
                const cc = s.format.colorChannels;
                const color = dab.color ?? (s.pattern?.impressionist ? this.#patternAt(dab.x, dab.y).color : s.color);
                for (let k = 0; k < cc; k++) {
                  const old = tile.paint[p * cc + k]!;
                  tile.paint[p * cc + k] = next > 0 ? (old * c * (1 - add) + color[k]! * add) / next : color[k]!;
                }
              }
              if (tile.cap) tile.cap[p] = Math.max(tile.cap[p]!, dab.opacity ?? s.opacity);
              tile.coverage[p] = next;
              this.#shade(tile, p, lx + s.offsetX, ly + s.offsetY);
              any = true;
            }
          }
          if (any) changed.add(tileKey(tx, ty));
        }
      }
    }
    return changed;
  }

  /** Recomputes one pixel (document position x, y) from its original value and the stroke's coverage. */
  #shade(tile: TileState, p: number, x: number, y: number): void {
    const s = this.#setup;
    const sel = tile.selection === 255 ? 1 : (tile.selection as Uint8Array)[p]! / 255;
    let cover = tile.coverage[p]!;
    if (s.dual) cover = combineDual(s.dual.mode, cover, tile.dual![p]!);
    if (s.texture && !s.texture.eachTip)
      cover = applyTexture(s.texture.mode, cover, tile.texture![p]!, s.texture.depth);
    if (s.wetEdges) {
      const raw = tile.coverage[p]!;
      cover = wetEdge(cover, raw > 0 ? Math.min(1, tile.inner![p]! / raw) : 0);
    }
    let e = (tile.cap ? tile.cap[p]! : s.opacity) * cover * sel;
    const cc = s.format.colorChannels;
    let color = tile.paint ? this.#paintColor(tile.paint, p, cc) : s.color;
    if (this.#pattern && !s.pattern!.impressionist) {
      // The pattern under the pixel, its transparency lowering the paint.
      const at = this.#patternAt(x + 0.5, y + 0.5);
      color = at.color;
      e *= at.alpha;
    }
    const max = this.#max;
    const q = this.#q;
    const i = p * this.#spp;
    const o = tile.original;
    const out = tile.data;
    const keepAlpha = !s.format.hasAlpha || s.lockAlpha;
    const mode = s.erase ? 'erase' : s.mode;
    if (mode === 'erase' || mode === 'clear') {
      if (keepAlpha) {
        // The eraser paints the background colour where alpha cannot change; Clear does nothing there.
        if (mode === 'erase') for (let c = 0; c < cc; c++) out[i + c] = q(o[i + c]! + (color[c]! - o[i + c]!) * e);
        return;
      }
      out[i + cc] = q(o[i + cc]! * (1 - e));
      return;
    }
    if (mode === 'dissolve') e = dissolveNoise(x, y) < e ? 1 : 0;
    const ao = keepAlpha ? 1 : o[i + cc]! / max;
    if (mode === 'behind') {
      // Paint under the pixel: the pixel over the paint.
      if (keepAlpha) return;
      const a = ao + e * (1 - ao);
      for (let c = 0; c < cc; c++) out[i + c] = a > 0 ? q((o[i + c]! * ao + color[c]! * e * (1 - ao)) / a) : o[i + c]!;
      out[i + cc] = q(a * max);
      return;
    }
    // The paint's colour blended with the pixel (as a layer of paint over it).
    const blended = this.#blended;
    if (mode === 'normal' || mode === 'dissolve') {
      for (let c = 0; c < cc; c++) blended[c] = color[c]!;
    } else if (isWholeColorMode(mode) && cc === 3) {
      const b = [o[i]! / max, o[i + 1]! / max, o[i + 2]! / max];
      const src = [color[0]! / max, color[1]! / max, color[2]! / max];
      const r = blendColor(mode, b, src, this.#hdr);
      for (let c = 0; c < 3; c++) blended[c] = r[c]! * max;
    } else {
      for (let c = 0; c < cc; c++)
        blended[c] = blendChannel(mode, o[i + c]! / max, color[c]! / max, 1, this.#hdr) * max;
    }
    if (keepAlpha) {
      for (let c = 0; c < cc; c++) out[i + c] = q(o[i + c]! + (blended[c]! - o[i + c]!) * e);
      return;
    }
    // Paint over the pixel: where the pixel is transparent the paint shows as is; elsewhere the blend.
    const a = e + ao * (1 - e);
    for (let c = 0; c < cc; c++) {
      const v = (1 - ao) * e * color[c]! + ao * e * blended[c]! + (1 - e) * ao * o[i + c]!;
      out[i + c] = a > 0 ? q(v / a) : o[i + c]!;
    }
    out[i + cc] = q(a * max);
  }

  /** The pattern's colour (scratch array, valid until the next call) and alpha at a document point. */
  #patternAt(x: number, y: number): { color: number[]; alpha: number } {
    const pat = this.#setup.pattern!;
    const data = this.#pattern!;
    const n = this.#setup.format.colorChannels + 1;
    const w = pat.width;
    const h = pat.height;
    const px = (((Math.floor(x - pat.originX) % w) + w) % w) | 0;
    const py = (((Math.floor(y - pat.originY) % h) + h) % h) | 0;
    const o = (py * w + px) * n;
    const out = this.#patternColor;
    for (let c = 0; c < n - 1; c++) out[c] = data[o + c]!;
    return { color: out, alpha: data[o + n - 1]! };
  }

  /** The paint colour at pixel p (scratch array, valid until the next call). */
  #paintColor(paint: Float32Array, p: number, cc: number): number[] {
    const out = this.#paintScratch;
    for (let k = 0; k < cc; k++) out[k] = paint[p * cc + k]!;
    return out;
  }

  /** The current data of tiles by key (for returning edited copies). */
  tile(key: number): { tx: number; ty: number; data: SampleArray } | undefined {
    const t = this.#tiles.get(key);
    return t && { tx: t.tx, ty: t.ty, data: t.data };
  }
}

/**
 * Whether a stroke stays within what the WebAssembly painter covers (pixel-ops `BrushStroke`):
 * Normal, Behind, Clear or erasing, without texture, dual brush, wet edges, noise, or colours
 * and opacities that vary per dab. Others are painted by this renderer.
 */
export function wasmCanPaint(setup: StrokeSetup): boolean {
  return (
    (setup.erase || setup.mode === 'normal' || setup.mode === 'behind' || setup.mode === 'clear') &&
    !setup.varyColor &&
    !setup.varyOpacity &&
    !setup.pattern &&
    !setup.texture &&
    !setup.dual &&
    !setup.noise &&
    !setup.wetEdges &&
    setup.format.colorChannels <= 56
  );
}

/** Layer tiles (layer tile coordinates) the dabs touch (`sampled` / `dualSampled`: the tips are images). */
export function dabTiles(
  dabs: readonly Dab[],
  offsetX: number,
  offsetY: number,
  sampled = false,
  dualSampled = false,
): [number, number][] {
  const out = new Map<number, [number, number]>();
  for (const dab of dabs) {
    const b = dabBounds(dab, dab.dual ? dualSampled : sampled);
    const x0 = b.x - offsetX;
    const y0 = b.y - offsetY;
    for (let ty = tileIndex(y0); ty <= tileIndex(y0 + b.h - 1); ty++)
      for (let tx = tileIndex(x0); tx <= tileIndex(x0 + b.w - 1); tx++) out.set(tileKey(tx, ty), [tx, ty]);
  }
  return [...out.values()];
}
