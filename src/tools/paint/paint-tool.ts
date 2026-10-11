/**
 * Brush, Pencil and Mixer Brush (B, Shift+B to switch), Eraser (E), Pattern Stamp (S),
 * History Brush and Art History Brush (Y) tools.
 *
 * Behaviour (own summary of the reference app):
 * - Drag to paint with the foreground colour (Brush) or to erase (Eraser: to
 *   transparency, or to the background colour on the Background and on layers
 *   with locked transparency). Each stroke is one History step.
 * - Shift-click paints a straight line from the end of the previous stroke.
 * - The Pencil paints hard pixels only (no soft or anti-aliased edge). With Auto
 *   Erase, a stroke that starts on the foreground colour paints the background colour.
 * - Eraser modes: Brush, Pencil (hard pixels) and Block (a square of fixed size on
 *   screen, at full strength).
 * - Painting stays inside the selection, if there is one.
 * - The brush outline follows the pointer.
 * - With Build-up (airbrush), holding the pointer still keeps adding paint.
 * - Smoothing (options bar) lets the paint trail the pointer on a string, shown
 *   while painting; the brush's Smoothing setting draws curves through the samples
 *   (see core/paint/smoothing.ts). The smoothed path is what the stroke records.
 * - The cursor follows Preferences > Cursors: the tool's icon, a crosshair, or the
 *   tip's outline (where it paints at least half, or at all); Caps Lock swaps in
 *   the crosshair.
 * - With the Brush, Alt/Option-click (or drag) picks the foreground colour off the
 *   image, as the Eyedropper does (with its options).
 * - The Pattern Stamp paints a pattern. Aligned keeps it continuous from stroke to
 *   stroke (fixed to the document); otherwise each stroke starts it afresh where the
 *   stroke begins. Impressionist paints each dab in one colour taken from the pattern.
 * - Alt+right-drag (Ctrl+Option-drag on macOS) shows the brush HUD: drag left or
 *   right for the size, up (softer) or down (harder) for a round tip's hardness —
 *   or the opacity, by preference and for sampled tips.
 * - The History Brush (Y) paints the layer back to how it was in the History Brush
 *   source (chosen in the History panel's left column; the opening state unless
 *   changed). The Art History Brush (Shift+Y) paints short stylised strokes in the
 *   source's colours: Style sets their shape, Area how far around the pointer they
 *   start, Tolerance keeps them to where the layer differs from the source; it keeps
 *   painting while the pointer rests. Neither uses paint symmetry.
 * - The Eraser's Erase to History brings back the source instead of erasing; holding
 *   Alt/Option when a stroke starts turns it on (or off) for that stroke.
 * - Dodge and Burn (O, Shift+O cycles with the Sponge) lighten or darken the tones in
 *   their Range by Exposure; Alt/Option held when a stroke starts switches between them for
 *   that stroke. The Sponge saturates or desaturates (core/paint/tone.ts). None paints with
 *   paint symmetry.
 * - Blur, Sharpen and Smudge (no letter; the group after the Gradient's) work on the pixels
 *   they pass over (core/paint/retouch.ts). Alt/Option held when a stroke starts switches
 *   between Blur and Sharpen, or Finger Painting on or off for the Smudge, for that stroke.
 * - The Mixer Brush mixes its paint with the canvas (core/paint/mixer.ts). Alt/Option-click
 *   loads it with the image under the tip; choosing a foreground colour loads that colour.
 *   What it holds carries from stroke to stroke unless it is cleaned and loaded after each.
 */
import { usesSymmetry, type PaintTool } from '../../core/commands/builtin/paint';
import { DEFAULT_PATTERN_ID } from '../../core/pattern/pattern';
import { DEFAULT_ART_HISTORY, type ArtHistoryOptions } from '../../core/paint/art-history';
import { DEFAULT_RETOUCH, RETOUCH_MODES, type RetouchOptions } from '../../core/paint/retouch';
import {
  DEFAULT_DODGE,
  DEFAULT_SPONGE,
  TONE_RANGES,
  type DodgeOptions,
  type SpongeOptions,
} from '../../core/paint/tone';
import {
  DEFAULT_MIXER,
  INITIAL_MIXER,
  afterStroke,
  type MixerBrushState,
  type MixerOptions,
} from '../../core/paint/mixer';
import { DEFAULT_BRUSH, type BrushSettings, type StrokePoint } from '../../core/paint/brush';
import { DEFAULT_DYNAMICS, StrokeDabber } from '../../core/paint/dynamics';
import {
  CurveSmoother,
  DEFAULT_SMOOTHING,
  StrokeSmoother,
  smoothingRadius,
  type SmoothingOptions,
} from '../../core/paint/smoothing';
import {
  effectivePaintCursor,
  type BrushAdjuster,
  type BrushOutline,
  type CursorState,
  type MixerBegin,
  type PaintBeginOptions,
  type PaintStroke,
  type Tool,
  type ToolContext,
  type ToolPointerEvent,
} from '../types';
import {
  ART_HISTORY_CURSOR,
  BLUR_CURSOR,
  BRUSH_CURSOR,
  BURN_CURSOR,
  DODGE_CURSOR,
  ERASER_CURSOR,
  EYEDROPPER_CURSOR,
  HISTORY_BRUSH_CURSOR,
  MIXER_CURSOR,
  MIXER_LOAD_CURSOR,
  SHARPEN_CURSOR,
  SMUDGE_CURSOR,
  SPONGE_CURSOR,
  STAMP_CURSOR,
} from './cursors';
import { ColorSampler } from '../eyedropper/sampler';

/** The Pattern Stamp's options. */
export interface StampOptions {
  patternId: string;
  /** The pattern stays continuous from stroke to stroke. */
  aligned: boolean;
  /** Each dab paints one colour from the pattern. */
  impressionist: boolean;
}

/** A stroke being painted: the host's session, the spacer and smoothing, and the samples recorded. */
interface ActiveStroke {
  session: PaintStroke;
  spacer: StrokeDabber;
  smoother: StrokeSmoother;
  curves: CurveSmoother | null;
  points: StrokePoint[];
  start: number;
}

const TOOL_NAMES: Record<PaintTool, string> = {
  brush: 'Brush Tool',
  pencil: 'Pencil Tool',
  eraser: 'Eraser Tool',
  'pattern-stamp': 'Pattern Stamp Tool',
  'history-brush': 'History Brush Tool',
  'art-history-brush': 'Art History Brush Tool',
  'mixer-brush': 'Mixer Brush Tool',
  dodge: 'Dodge Tool',
  burn: 'Burn Tool',
  sponge: 'Sponge Tool',
  blur: 'Blur Tool',
  sharpen: 'Sharpen Tool',
  smudge: 'Smudge Tool',
};

const TOOL_KEYS: Record<PaintTool, string> = {
  brush: 'B',
  pencil: 'B',
  eraser: 'E',
  'pattern-stamp': 'S',
  'history-brush': 'Y',
  'art-history-brush': 'Y',
  'mixer-brush': 'B',
  dodge: 'O',
  burn: 'O',
  sponge: 'O',
  // No letter by default.
  blur: '',
  sharpen: '',
  smudge: '',
};

const STANDARD_CURSORS: Record<PaintTool, string> = {
  brush: BRUSH_CURSOR,
  pencil: BRUSH_CURSOR,
  eraser: ERASER_CURSOR,
  'pattern-stamp': STAMP_CURSOR,
  'history-brush': HISTORY_BRUSH_CURSOR,
  'art-history-brush': ART_HISTORY_CURSOR,
  'mixer-brush': MIXER_CURSOR,
  dodge: DODGE_CURSOR,
  burn: BURN_CURSOR,
  sponge: SPONGE_CURSOR,
  blur: BLUR_CURSOR,
  sharpen: SHARPEN_CURSOR,
  smudge: SMUDGE_CURSOR,
};

export class PaintingTool implements Tool {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly kind: PaintTool;
  readonly options: BrushSettings;
  /** Smoothing (options bar) and curves (the brush's Smoothing setting). */
  readonly smoothing: SmoothingOptions = { ...DEFAULT_SMOOTHING };
  /** The brush preset last chosen (the Brushes panel shows it selected), or null. */
  presetId: string | null = null;
  /** Protect Texture (Brush Settings): switching presets keeps the texture's pattern and scale. */
  protectTexture = false;
  /** Pencil: Auto Erase. */
  autoErase = false;
  /** Eraser: what it erases with. */
  eraserMode: 'brush' | 'pencil' | 'block' = 'brush';
  /** Pattern Stamp: the pattern, Aligned and Impressionist. */
  readonly stamp: StampOptions = { patternId: DEFAULT_PATTERN_ID, aligned: true, impressionist: false };
  /** Eraser: Erase to History. */
  eraseToHistory = false;
  /** Art History Brush: style, area and tolerance. */
  readonly art: ArtHistoryOptions = { ...DEFAULT_ART_HISTORY };
  /** Dodge and Burn: Range, Exposure and Protect Tones. */
  readonly tone: DodgeOptions = { ...DEFAULT_DODGE };
  /** Sponge: Saturate or Desaturate, and Vibrance (its Flow is the brush's). */
  readonly sponge: SpongeOptions = { ...DEFAULT_SPONGE };
  /** Blur, Sharpen and Smudge: Mode, Strength, Sample All Layers, Protect Detail, Finger Painting. */
  readonly retouch: RetouchOptions = { ...DEFAULT_RETOUCH };
  /** Mixer Brush: Wet, Load, Mix, Sample All Layers, loading and cleaning after each stroke. */
  readonly mixer: MixerOptions = { ...DEFAULT_MIXER };
  /** Mixer Brush: what the brush holds (it may lag behind a stroke still finishing). */
  mixerState: MixerBrushState = INITIAL_MIXER;
  /** Called when what the Mixer Brush holds changes (the options bar shows it). */
  onMixerChange: (() => void) | null = null;
  /** Settles when the last Mixer Brush stroke or load has updated `mixerState`. */
  #mixerReady: Promise<void> = Promise.resolve();
  #stroke: ActiveStroke | null = null;
  /** End of the last stroke, for Shift-click lines. */
  #lastEnd: StrokePoint | null = null;
  /** Alt-click with the Brush: picking the foreground colour. */
  readonly #sampler = new ColorSampler();
  /** While a stroke lasts: Stroke Catch-up and Build-up go on with the pointer at rest. */
  #timer: ReturnType<typeof setInterval> | null = null;
  /** The brush HUD gesture: where it started and the settings then. */
  #adjust: {
    x: number;
    y: number;
    at: { x: number; y: number };
    size: number;
    hardness: number;
    opacity: number;
  } | null = null;

  constructor(kind: PaintTool) {
    this.kind = kind;
    this.id = kind;
    this.name = TOOL_NAMES[kind];
    this.key = TOOL_KEYS[kind];
    const size =
      kind === 'brush' || kind === 'mixer-brush' ? 30 : kind === 'pencil' ? 1 : kind === 'art-history-brush' ? 10 : 50;
    this.options = {
      ...DEFAULT_BRUSH,
      size,
      // Wet paint shows each dab of a widely spaced brush: the Mixer Brush starts closely spaced.
      ...(kind === 'mixer-brush' ? { spacing: 0.05 } : {}),
      // The Sponge works at half flow at first.
      ...(kind === 'sponge' ? { flow: 0.5 } : {}),
      // The Smudge lays down whole dabs: closely spaced, their edges do not show.
      ...(kind === 'smudge' ? { spacing: 0.1 } : {}),
      aliased: kind === 'pencil',
      dynamics: structuredClone(DEFAULT_DYNAMICS),
    };
    // The Pencil draws exact lines, and the Art History Brush places its own strokes: no smoothing unless asked.
    if (kind === 'pencil' || kind === 'art-history-brush') this.smoothing.amount = 0;
  }

  setAutoErase(on: boolean): void {
    this.autoErase = on;
  }

  setEraserMode(mode: 'brush' | 'pencil' | 'block'): void {
    this.eraserMode = mode;
  }

  setStamp(changes: Partial<StampOptions>): void {
    Object.assign(this.stamp, changes);
  }

  setEraseToHistory(on: boolean): void {
    this.eraseToHistory = on;
  }

  setArt(changes: Partial<ArtHistoryOptions>): void {
    Object.assign(this.art, changes);
  }

  setMixer(changes: Partial<MixerOptions>): void {
    Object.assign(this.mixer, changes);
  }

  setTone(changes: Partial<DodgeOptions>): void {
    Object.assign(this.tone, changes);
  }

  setSponge(changes: Partial<SpongeOptions>): void {
    Object.assign(this.sponge, changes);
  }

  setRetouch(changes: Partial<RetouchOptions>): void {
    Object.assign(this.retouch, changes);
  }

  /** The tool a stroke paints as: Alt/Option switches between Dodge and Burn, and between Blur and Sharpen. */
  #strokeKind(altKey: boolean): PaintTool {
    if (!altKey) return this.kind;
    const other: Partial<Record<PaintTool, PaintTool>> = {
      dodge: 'burn',
      burn: 'dodge',
      blur: 'sharpen',
      sharpen: 'blur',
    };
    return other[this.kind] ?? this.kind;
  }

  /** Changes what the Mixer Brush holds, after any stroke still finishing has handed it on. */
  #updateMixer(change: Promise<((s: MixerBrushState) => MixerBrushState) | null>): void {
    this.#mixerReady = this.#mixerReady
      .then(async () => {
        const f = await change;
        if (!f) return;
        this.mixerState = f(this.mixerState);
        this.onMixerChange?.();
      })
      .catch(() => undefined);
  }

  /** Load Brush (and choosing a foreground colour): fills the reservoir with the foreground colour. */
  loadForeground(): void {
    this.#updateMixer(Promise.resolve((s) => ({ ...s, load: { kind: 'foreground' }, level: 1 })));
  }

  /** Clean Brush: empties the brush of all paint. */
  cleanBrush(): void {
    this.#updateMixer(Promise.resolve((s) => ({ ...s, level: 0, pickup: null })));
  }

  /** Settles once what the Mixer Brush holds is up to date (for tests and the options bar). */
  mixerSettled(): Promise<void> {
    return this.#mixerReady;
  }

  /** Alt-click with the Mixer Brush: loads it with the image under the tip (its average with Load Solid Colors Only). */
  #loadFromImage(e: ToolPointerEvent, ctx: ToolContext): void {
    const host = ctx.paint;
    if (!host?.loadMixer) return;
    const at = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
    const loaded = host.loadMixer(at, this.options.size, this.mixer.sampleAllLayers, this.mixer.solidOnly).then(
      (load) => (load ? (s: MixerBrushState): MixerBrushState => ({ ...s, load, level: 1 }) : null),
      (error: unknown) => {
        ctx.report('Could not load the Mixer Brush', error instanceof Error ? error.message : String(error));
        return null;
      },
    );
    this.#updateMixer(loaded);
  }

  /** A Mixer Brush stroke's start: it waits for the stroke before it, and hands on what it ends with. */
  #mixerStart(): { begin: MixerBegin; settle: () => void } {
    const ready = this.#mixerReady;
    let settle: () => void = () => {};
    this.#mixerReady = new Promise((resolve) => (settle = resolve));
    const options = { ...this.mixer };
    return {
      settle,
      begin: {
        options,
        state: ready.then(() => this.mixerState),
        finish: (end, mode) => {
          if (end) this.mixerState = afterStroke(this.mixerState, end, mode, options);
          settle();
          this.onMixerChange?.();
        },
      },
    };
  }

  /** Paint symmetry applies to the Brush, Pencil, Eraser and Pattern Stamp. */
  get usesSymmetry(): boolean {
    return usesSymmetry(this.kind);
  }

  /**
   * The brush a stroke paints with: the tool's, or for the Eraser's Pencil mode the same with hard
   * pixels, and for Block mode a full-strength square of 16 screen pixels.
   */
  #strokeBrush(ctx: ToolContext): BrushSettings {
    // Dodge and Burn: Exposure is the stroke's opacity; the Sponge has only Flow.
    if (this.kind === 'dodge' || this.kind === 'burn') return { ...this.options, opacity: this.tone.exposure, flow: 1 };
    if (this.kind === 'sponge') return { ...this.options, opacity: 1 };
    if (this.kind !== 'eraser' || this.eraserMode === 'brush') return this.options;
    if (this.eraserMode === 'pencil') return { ...this.options, aliased: true };
    return {
      ...DEFAULT_BRUSH,
      size: Math.max(1, Math.round((16 * ctx.devicePixelRatio) / ctx.viewport.zoom)),
      tip: 'pf-tip-square',
      aliased: true,
      dynamics: structuredClone(DEFAULT_DYNAMICS),
    };
  }

  setOptions(changes: Partial<BrushSettings>): void {
    Object.assign(this.options, changes);
  }

  setSmoothing(changes: Partial<SmoothingOptions>): void {
    Object.assign(this.smoothing, changes);
  }

  setProtectTexture(on: boolean): void {
    this.protectTexture = on;
  }

  /** The tool's settings for a tool preset (plain data). */
  presetOptions(): unknown {
    return JSON.parse(
      JSON.stringify({
        brush: this.options,
        smoothing: this.smoothing,
        protectTexture: this.protectTexture,
        autoErase: this.autoErase,
        eraserMode: this.eraserMode,
        stamp: this.stamp,
        eraseToHistory: this.eraseToHistory,
        art: this.art,
        mixer: this.mixer,
        tone: this.tone,
        sponge: this.sponge,
        retouch: this.retouch,
      }),
    );
  }

  /** Applies a tool preset's settings (as from presetOptions). */
  applyPresetOptions(raw: unknown): void {
    const o = (raw ?? {}) as {
      brush?: Partial<BrushSettings>;
      smoothing?: Partial<SmoothingOptions>;
      protectTexture?: boolean;
      autoErase?: boolean;
      eraserMode?: string;
      stamp?: Partial<StampOptions>;
      eraseToHistory?: boolean;
      art?: Partial<ArtHistoryOptions>;
      mixer?: Partial<MixerOptions>;
      tone?: Partial<DodgeOptions>;
      sponge?: Partial<SpongeOptions>;
      retouch?: Partial<RetouchOptions>;
    };
    if (o.brush) this.setOptions(JSON.parse(JSON.stringify(o.brush)) as Partial<BrushSettings>);
    if (o.smoothing) this.setSmoothing(o.smoothing);
    if (typeof o.protectTexture === 'boolean') this.protectTexture = o.protectTexture;
    if (typeof o.autoErase === 'boolean') this.autoErase = o.autoErase;
    if (o.eraserMode === 'brush' || o.eraserMode === 'pencil' || o.eraserMode === 'block')
      this.eraserMode = o.eraserMode;
    if (o.stamp) {
      if (typeof o.stamp.patternId === 'string') this.stamp.patternId = o.stamp.patternId;
      if (typeof o.stamp.aligned === 'boolean') this.stamp.aligned = o.stamp.aligned;
      if (typeof o.stamp.impressionist === 'boolean') this.stamp.impressionist = o.stamp.impressionist;
    }
    if (typeof o.eraseToHistory === 'boolean') this.eraseToHistory = o.eraseToHistory;
    if (o.art) {
      if (typeof o.art.style === 'string') this.art.style = o.art.style;
      if (typeof o.art.area === 'number') this.art.area = Math.min(500, Math.max(0, o.art.area));
      if (typeof o.art.tolerance === 'number') this.art.tolerance = Math.min(1, Math.max(0, o.art.tolerance));
    }
    if (o.mixer) {
      const m = o.mixer;
      const share = (v: unknown, lo: number) => (typeof v === 'number' ? Math.min(1, Math.max(lo, v)) : undefined);
      const wet = share(m.wet, 0);
      const load = share(m.load, 0.01);
      const mix = share(m.mix, 0);
      if (wet !== undefined) this.mixer.wet = wet;
      if (load !== undefined) this.mixer.load = load;
      if (mix !== undefined) this.mixer.mix = mix;
      for (const key of ['sampleAllLayers', 'loadAfterStroke', 'cleanAfterStroke', 'solidOnly'] as const)
        if (typeof m[key] === 'boolean') this.mixer[key] = m[key];
    }
    if (o.tone) {
      const t = o.tone;
      if (TONE_RANGES.some(([r]) => r === t.range)) this.tone.range = t.range!;
      if (typeof t.exposure === 'number') this.tone.exposure = Math.min(1, Math.max(0.01, t.exposure));
      if (typeof t.protectTones === 'boolean') this.tone.protectTones = t.protectTones;
    }
    if (o.sponge) {
      if (typeof o.sponge.saturate === 'boolean') this.sponge.saturate = o.sponge.saturate;
      if (typeof o.sponge.vibrance === 'boolean') this.sponge.vibrance = o.sponge.vibrance;
    }
    if (o.retouch) {
      const r = o.retouch;
      if (RETOUCH_MODES.some(([m]) => m === r.mode)) this.retouch.mode = r.mode!;
      if (typeof r.strength === 'number') this.retouch.strength = Math.min(1, Math.max(0.01, r.strength));
      for (const key of ['sampleAllLayers', 'protectDetail', 'fingerPainting'] as const)
        if (typeof r[key] === 'boolean') this.retouch[key] = r[key];
    }
    this.presetId = null;
  }

  cursor(state: CursorState): string {
    if (this.kind === 'brush' && (state.altKey || this.#sampler.active)) return EYEDROPPER_CURSOR;
    if (this.kind === 'mixer-brush' && state.altKey) return MIXER_LOAD_CURSOR;
    switch (state.paintCursor ?? 'precise') {
      case 'standard':
        return STANDARD_CURSORS[this.#strokeKind(state.altKey === true)];
      case 'precise':
        return 'crosshair';
      default:
        return 'none'; // the overlay draws the tip outline (and a crosshair when it is tiny)
    }
  }

  busy(): boolean {
    return this.#stroke !== null || this.#sampler.active;
  }

  #point(e: ToolPointerEvent, ctx: ToolContext, start = e.time ?? performance.now()): StrokePoint {
    const p = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
    return {
      x: p.x,
      y: p.y,
      pressure: e.pressure,
      tiltX: e.tiltX ?? 0,
      tiltY: e.tiltY ?? 0,
      twist: e.twist ?? 0,
      wheel: e.wheel ?? 0,
      time: Math.max(0, (e.time ?? performance.now()) - start),
    };
  }

  /** Paint points (after smoothing) go through the curves, into the record and to the spacer. */
  #feed(points: StrokePoint[]): void {
    const stroke = this.#stroke;
    if (!stroke) return;
    for (const p of points) for (const q of stroke.curves ? stroke.curves.push(p) : [p]) this.#paintAt(stroke, q);
  }

  /** A paint point into the record and to the spacer (the Art History Brush's session places its own dabs). */
  #paintAt(stroke: ActiveStroke, q: StrokePoint): void {
    stroke.points.push(q);
    if (stroke.session.addPoints) stroke.session.addPoints([q]);
    else stroke.session.add(stroke.spacer.add(q));
  }

  /**
   * While the stroke lasts and the pointer rests: Stroke Catch-up keeps the paint drifting to it,
   * and Build-up repeats where the paint is with the current time (recorded like any sample), so
   * the spacer keeps adding paint there.
   */
  #startTimer(buildUp: boolean): void {
    this.#stopTimer();
    this.#timer = setInterval(() => {
      const stroke = this.#stroke;
      if (!stroke) return;
      const now = performance.now() - stroke.start;
      this.#feed(stroke.smoother.tick(now));
      const at = stroke.smoother.paint;
      if (buildUp && at) this.#feed([{ ...at, time: Math.max(at.time, now) }]);
    }, 16);
  }

  #stopTimer(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * The cursor at the pointer — ahead of it where the browser predicts the next position — or
   * null when the cursor is the icon or the crosshair (CSS cursors, see `cursor`).
   */
  #outline(e: ToolPointerEvent, ctx: ToolContext, painting = false): BrushOutline | null {
    const prefs = ctx.cursorPreferences;
    const mode = effectivePaintCursor(prefs.painting, e.capsLock ?? false);
    if (mode === 'standard' || mode === 'precise') return null;
    const p = ctx.viewport.viewToDoc(e.predicted ?? { x: e.x, y: e.y });
    const o = this.#strokeBrush(ctx);
    const base = {
      x: p.x,
      y: p.y,
      size: o.size,
      angle: o.angle,
      roundness: o.roundness,
      flipX: o.flipX,
      flipY: o.flipY,
      tip: o.tip,
    };
    // While smoothing, the string from the pointer to where the paint is.
    const smoother = painting ? this.#stroke?.smoother : undefined;
    const paintAt = smoother?.active ? smoother.paint : null;
    const string = paintAt
      ? {
          paintAt: { x: paintAt.x, y: paintAt.y },
          ...(this.smoothing.pulledString ? { stringRadius: smoother!.radius } : {}),
        }
      : {};
    if (painting && prefs.crosshairWhilePainting) return { ...base, ...string, crosshairOnly: true };
    return {
      ...base,
      ...string,
      contour: mode === 'full' ? 'full' : 'normal',
      hardness: o.hardness,
      crosshair: prefs.crosshairInTip,
    };
  }

  readonly adjustBrush: BrushAdjuster = {
    begin: (e, ctx) => {
      if (this.#stroke || !ctx.document) return false;
      const o = this.options;
      const at = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
      this.#adjust = { x: e.x, y: e.y, at, size: o.size, hardness: o.hardness, opacity: o.opacity };
      ctx.setBrushOutline(null);
      this.#showHud(ctx);
      return true;
    },
    move: (e, ctx) => {
      const a = this.#adjust;
      if (!a) return;
      // Horizontally the outline's edge follows the pointer; vertically 1 % per CSS pixel.
      const size = Math.round(a.size + (2 * (e.x - a.x)) / ctx.viewport.zoom);
      const dy = (e.y - a.y) / ctx.devicePixelRatio / 100;
      const changes: Partial<BrushSettings> = { size: Math.min(5000, Math.max(1, size)) };
      const percent = (v: number, lo: number) => Math.round(Math.min(1, Math.max(lo, v)) * 100) / 100;
      if (this.options.tip === null && ctx.cursorPreferences.hudHardness)
        changes.hardness = percent(a.hardness + dy, 0);
      else changes.opacity = percent(a.opacity + dy, 0.01);
      this.setOptions(changes);
      ctx.toolOptionsChanged();
      this.#showHud(ctx);
    },
    end: (ctx) => {
      this.#adjust = null;
      ctx.setBrushHud(null);
    },
  };

  #showHud(ctx: ToolContext): void {
    const a = this.#adjust;
    if (!a) return;
    const o = this.options;
    ctx.setBrushHud({
      x: a.at.x,
      y: a.at.y,
      size: o.size,
      hardness: o.hardness,
      angle: o.angle,
      roundness: o.roundness,
      flipX: o.flipX,
      flipY: o.flipY,
      tip: o.tip,
      color: ctx.cursorPreferences.previewColor,
      lines: [
        `Diameter: ${o.size} px`,
        ...(o.tip === null ? [`Hardness: ${Math.round(o.hardness * 100)}%`] : []),
        `Opacity: ${Math.round(o.opacity * 100)}%`,
      ],
    });
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!ctx.document || this.#stroke) return;
    if (this.kind === 'brush' && e.altKey) {
      ctx.setBrushOutline(null);
      this.#sampler.begin(e, ctx, 'foreground');
      return;
    }
    if (this.kind === 'mixer-brush' && e.altKey) {
      this.#loadFromImage(e, ctx);
      return;
    }
    if (!ctx.paint) return;
    const brush = this.#strokeBrush(ctx);
    const startAt = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
    const mixer = this.kind === 'mixer-brush' ? this.#mixerStart() : null;
    const kind = this.#strokeKind(e.altKey);
    const session = ctx.paint.begin(
      kind,
      brush,
      mixer ? { mixer: mixer.begin } : this.#beginOptions(startAt, e.altKey, kind),
    );
    if (!session) {
      mixer?.settle();
      return;
    }
    const spacer = new StrokeDabber(
      brush,
      session.seed,
      session.colors,
      session.symmetry,
      mixer ? { wet: mixer.begin.options.wet, mix: mixer.begin.options.mix } : null,
    );
    const start = e.time ?? performance.now();
    const p = this.#point(e, ctx, start);
    const s = this.smoothing;
    const smoother = new StrokeSmoother(s, smoothingRadius(s, ctx.viewport.zoom, ctx.devicePixelRatio));
    const curves = s.curves ? new CurveSmoother() : null;
    this.#stroke = { session, spacer, smoother, curves, points: [], start };
    if (e.shiftKey && this.#lastEnd) {
      // A straight line from where the last stroke ended.
      this.#feed([{ ...this.#lastEnd, time: 0 }]);
    }
    this.#feed(smoother.add(p));
    // The Art History Brush keeps painting while the pointer rests.
    const buildUp = !!this.options.dynamics?.buildUp || this.kind === 'art-history-brush';
    if (buildUp || (smoother.active && s.catchUp && !s.pulledString)) this.#startTimer(buildUp);
    ctx.setBrushOutline(this.#outline(e, ctx, true));
  }

  /** What a stroke starting at `at` takes beyond the brush; Alt turns the Eraser's Erase to History on or off. */
  #beginOptions(at: { x: number; y: number }, altKey: boolean, kind: PaintTool): PaintBeginOptions | undefined {
    switch (this.kind) {
      case 'dodge':
      case 'burn':
        return {
          tone: { kind: kind === 'burn' ? 'burn' : 'dodge', range: this.tone.range, protect: this.tone.protectTones },
        };
      case 'sponge':
        return { tone: { kind: 'sponge', saturate: this.sponge.saturate, vibrance: this.sponge.vibrance } };
      case 'blur':
      case 'sharpen':
      case 'smudge': {
        const r = this.retouch;
        return {
          retouch: {
            mode: r.mode,
            strength: r.strength,
            sampleAllLayers: r.sampleAllLayers,
            ...(kind === 'sharpen' ? { protectDetail: r.protectDetail } : {}),
            ...(kind === 'smudge' ? { finger: r.fingerPainting !== altKey } : {}),
          },
        };
      }
      case 'pencil':
        return this.autoErase ? { autoEraseAt: at } : undefined;
      case 'eraser':
        return this.eraseToHistory !== altKey ? { toHistory: true } : undefined;
      case 'art-history-brush':
        return { art: { ...this.art } };
      case 'pattern-stamp':
        return {
          pattern: {
            id: this.stamp.patternId,
            // Aligned: fixed to the document; otherwise starting where this stroke starts.
            originX: this.stamp.aligned ? 0 : Math.floor(at.x),
            originY: this.stamp.aligned ? 0 : Math.floor(at.y),
            impressionist: this.stamp.impressionist,
          },
        };
      default:
        return undefined;
    }
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.#sampler.active) {
      this.#sampler.move(e, ctx);
      return;
    }
    const stroke = this.#stroke;
    if (stroke) this.#feed(stroke.smoother.add(this.#point(e, ctx, stroke.start)));
    ctx.setBrushOutline(this.#outline(e, ctx, stroke !== null));
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.#sampler.active) {
      this.#sampler.end(e, ctx);
      return;
    }
    const stroke = this.#stroke;
    this.#stopTimer();
    if (!stroke) return;
    // Catch-up on Stroke End, then the last stretch of the curve.
    this.#feed(stroke.smoother.end());
    if (stroke.curves) for (const q of stroke.curves.flush()) this.#paintAt(stroke, q);
    this.#stroke = null;
    ctx.setBrushOutline(this.#outline(e, ctx)); // back from the painting cursor
    this.#lastEnd = stroke.points.at(-1) ?? null;
    void stroke.session.end(stroke.points).catch(() => {
      // The session already restored the layer; the host reports problems.
    });
  }

  onPointerHover(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!ctx.document) return;
    // Alt with the Brush shows the Eyedropper instead of the tip, with the Mixer Brush the loading target.
    const alt = e.altKey && (this.kind === 'brush' || this.kind === 'mixer-brush');
    ctx.setBrushOutline(alt ? null : this.#outline(e, ctx));
  }

  onPointerLeave(ctx: ToolContext): void {
    ctx.setBrushOutline(null);
  }

  activate(ctx: ToolContext): void {
    ctx.showSymmetry(this.usesSymmetry);
  }

  deactivate(ctx: ToolContext): void {
    ctx.showSymmetry(false);
    ctx.setBrushOutline(null);
  }

  cancel(ctx: ToolContext): void {
    this.#sampler.cancel(ctx);
    const stroke = this.#stroke;
    this.#stroke = null;
    this.#stopTimer();
    ctx.setBrushOutline(null);
    if (stroke) void stroke.session.cancel();
  }
}
