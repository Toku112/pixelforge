/**
 * Brush dynamics: how each dab of a stroke varies (Brush Settings panel sections
 * Shape Dynamics, Scattering, Transfer, Color Dynamics and Brush Pose).
 *
 * Behaviour (own summary of the reference app):
 * - Jitter varies a value randomly per dab, never above the set value for size;
 *   Angle Jitter 100 % turns the tip anywhere in a full circle.
 * - A Control ties a value to the pen or the stroke: Fade (over a number of dabs),
 *   Pen Pressure, Pen Tilt, Stylus Wheel, Rotation (barrel), and for the angle also
 *   Initial Direction and Direction. Minimum Diameter / Minimum Roundness are floors.
 * - Scattering throws dabs sideways (Both Axes: also along the stroke) by a share of
 *   the diameter, several per step (Count, Count Jitter).
 * - Transfer varies each dab's opacity and flow, and for the Mixer Brush its Wet and Mix.
 * - Color Dynamics varies the colour between foreground and background and in hue,
 *   saturation and brightness, per stroke or per dab; Purity shifts saturation.
 * - Brush Pose overrides the pen's tilt, rotation or pressure.
 * - Texture, Dual Brush, Noise and Wet Edges are settings here too (the renderer
 *   applies them; see texture.ts). Texture Each Tip can vary the depth per dab
 *   (Depth Jitter, Minimum Depth); the dual tip is stamped along the same path with
 *   its own size, spacing, scatter and count, scaled with the brush size.
 * - Build-up (airbrush): paint keeps building while the pointer is held still.
 *
 * Randomness comes from a generator seeded per stroke, recorded with the stroke, so
 * replaying it paints exactly the same dabs.
 */
import { hsbToRgb, rgbToHsb, type RGB } from '../color/color';
import { seededRandom } from '../random';
import { DabSpacer, type BrushSettings, type Dab, type StrokePoint } from './brush';
import { DUAL_MODES, TEXTURE_MODES, type DualMode, type TextureMode } from './texture';
import { applySymmetry, symmetryCopies, type Symmetry } from './symmetry';

export { seededRandom };

export type DynamicsControl =
  'off' | 'fade' | 'pressure' | 'tilt' | 'wheel' | 'rotation' | 'initial-direction' | 'direction';

export interface ControlledJitter {
  /** 0–1. */
  jitter: number;
  control: DynamicsControl;
  /** Fade length in dabs (Control = Fade). */
  fadeSteps: number;
  /** Floor the control (and jitter) never go below, 0–1 (Minimum Diameter / Roundness; unused for the angle). */
  minimum: number;
}

export interface BrushDynamics {
  shape: {
    enabled: boolean;
    size: ControlledJitter;
    /** How much pen tilt can enlarge the tip (Control = Pen Tilt), 0–2. */
    tiltScale: number;
    angle: ControlledJitter;
    roundness: ControlledJitter;
    flipXJitter: boolean;
    flipYJitter: boolean;
  };
  scatter: {
    enabled: boolean;
    /** Share of the diameter, 0–10 (0–1000 %). */
    amount: number;
    bothAxes: boolean;
    control: DynamicsControl;
    fadeSteps: number;
    /** Dabs per spacing step, 1–16. */
    count: number;
    countJitter: ControlledJitter;
  };
  transfer: {
    enabled: boolean;
    opacity: ControlledJitter;
    flow: ControlledJitter;
    /** Mixer Brush: Wetness Jitter and Mix Jitter. */
    wetness: ControlledJitter;
    mix: ControlledJitter;
  };
  color: {
    enabled: boolean;
    /** Vary per dab (otherwise once per stroke). */
    perTip: boolean;
    /** Mix towards the background colour. */
    fgbg: ControlledJitter;
    /** 0–1 each. */
    hue: number;
    saturation: number;
    brightness: number;
    /** −1 (gray) … 1 (fully saturated). */
    purity: number;
  };
  pose: {
    enabled: boolean;
    overrideTilt: boolean;
    tiltX: number;
    tiltY: number;
    overrideRotation: boolean;
    rotation: number;
    overridePressure: boolean;
    pressure: number;
  };
  texture: {
    enabled: boolean;
    /** Pattern id (pattern library). */
    pattern: string;
    invert: boolean;
    /** 0.01–10 (1–1000 %). */
    scale: number;
    /** −150…150. */
    brightness: number;
    /** −50…100. */
    contrast: number;
    eachTip: boolean;
    mode: TextureMode;
    /** 0–1. */
    depth: number;
    /** Per-dab depth (Texture Each Tip only); its minimum is Minimum Depth. */
    depthJitter: ControlledJitter;
  };
  dual: {
    enabled: boolean;
    mode: DualMode;
    /** Flip each dual dab at random. */
    flip: boolean;
    /** Sampled tip id, or null for a round tip of `hardness`. */
    tip: string | null;
    hardness: number;
    /** Diameter as a share of the brush size (it scales with the brush), 0.001–100. */
    size: number;
    /** Share of the dual diameter, 0.01–10. */
    spacing: number;
    /** Share of the dual diameter, 0–10. */
    scatter: number;
    bothAxes: boolean;
    /** 1–16. */
    count: number;
  };
  /** Roughens soft tip edges. */
  noise: boolean;
  /** Paint gathers at the stroke's edges. */
  wetEdges: boolean;
  /** Airbrush: paint builds up while the pointer is held still. */
  buildUp: boolean;
}

/** Build-up: one dab every this many milliseconds while the pointer is held still (30 per second). */
export const BUILD_UP_INTERVAL = 1000 / 30;

const jitter = (control: DynamicsControl = 'off'): ControlledJitter => ({
  jitter: 0,
  control,
  fadeSteps: 25,
  minimum: 0,
});

export const DEFAULT_DYNAMICS: BrushDynamics = {
  shape: {
    enabled: false,
    size: jitter(),
    tiltScale: 0,
    angle: jitter(),
    roundness: { ...jitter(), minimum: 0.25 },
    flipXJitter: false,
    flipYJitter: false,
  },
  scatter: {
    enabled: false,
    amount: 0,
    bothAxes: false,
    control: 'off',
    fadeSteps: 25,
    count: 1,
    countJitter: jitter(),
  },
  transfer: { enabled: false, opacity: jitter(), flow: jitter(), wetness: jitter(), mix: jitter() },
  color: { enabled: false, perTip: true, fgbg: jitter(), hue: 0, saturation: 0, brightness: 0, purity: 0 },
  pose: {
    enabled: false,
    overrideTilt: false,
    tiltX: 0,
    tiltY: 0,
    overrideRotation: false,
    rotation: 0,
    overridePressure: false,
    pressure: 1,
  },
  texture: {
    enabled: false,
    pattern: 'pf-paper', // the first built-in pattern (core/pattern)
    invert: false,
    scale: 1,
    brightness: 0,
    contrast: 0,
    eachTip: false,
    mode: 'multiply',
    depth: 1,
    depthJitter: jitter(),
  },
  dual: {
    enabled: false,
    mode: 'multiply',
    flip: false,
    tip: null,
    hardness: 1,
    size: 0.5,
    spacing: 0.25,
    scatter: 0,
    bothAxes: false,
    count: 1,
  },
  noise: false,
  wetEdges: false,
  buildUp: false,
};

/** True when Texture Each Tip varies the depth per dab. */
const depthVaries = (t: BrushDynamics['texture']) =>
  t.enabled && t.eachTip && (t.depthJitter.jitter > 0 || t.depthJitter.control !== 'off');

/** True when no dab varies (the plain brush; texture, noise and wet edges may still apply). */
export function dynamicsOff(d: BrushDynamics | undefined): boolean {
  return (
    !d ||
    (!d.shape.enabled &&
      !d.scatter.enabled &&
      !d.transfer.enabled &&
      !d.color.enabled &&
      !d.pose.enabled &&
      !depthVaries(d.texture))
  );
}

/** A placed dab before dynamics: where, the pen there, and the stroke's direction (radians, screen). */
export interface Placement {
  point: StrokePoint;
  /** Index of the placement in the stroke (for Fade). */
  index: number;
  direction: number;
  initialDirection: number;
}

/** The Mixer Brush's Wet and Mix, which Transfer varies per dab. */
export interface MixerBase {
  wet: number;
  mix: number;
}

/** The colours a stroke may use (sRGB 0–1) and how to make samples of them. */
export interface DynamicsColors {
  foreground: RGB;
  background: RGB;
  toSamples: (c: RGB) => number[];
}

const DEG = 180 / Math.PI;

export class DabDynamics {
  readonly #d: BrushDynamics;
  readonly #random: () => number;
  readonly #colors: DynamicsColors | null;
  /** The brush's Opacity: Transfer varies each dab's opacity below it. */
  readonly #opacity: number;
  /** The stroke's colour when Color Dynamics vary per stroke. */
  #strokeColor: number[] | null = null;
  /** Mixer Brush strokes: the Wet and Mix that Transfer varies (other strokes draw no numbers for them). */
  readonly #mixer: MixerBase | null;

  constructor(
    dynamics: BrushDynamics,
    seed: number,
    colors: DynamicsColors | null,
    opacity = 1,
    mixer: MixerBase | null = null,
  ) {
    this.#d = dynamics;
    this.#random = seededRandom(seed);
    this.#colors = colors;
    this.#opacity = opacity;
    this.#mixer = mixer;
  }

  /** 0–1 from a control at a placement (1 when off). For Fade, falls from 1 to 0 over `fadeSteps`. */
  #control(control: DynamicsControl, fadeSteps: number, p: Placement): number {
    const pt = p.point;
    switch (control) {
      case 'off':
        return 1;
      case 'fade':
        return fadeSteps > 0 ? Math.max(0, 1 - p.index / fadeSteps) : 1;
      case 'pressure':
        return pt.pressure;
      case 'tilt':
        // Upright pen = 1, lying flat = 0.
        return 1 - Math.min(90, Math.hypot(pt.tiltX, pt.tiltY)) / 90;
      case 'wheel':
        return pt.wheel;
      case 'rotation':
        return (((pt.twist % 360) + 360) % 360) / 360;
      default:
        return 1;
    }
  }

  /** A value from a control and jitter: base × lerp(minimum, 1, control) × (1 − jitter × random), at least minimum × base. */
  #vary(j: ControlledJitter, p: Placement): number {
    const c = this.#control(j.control, j.fadeSteps, p);
    const controlled = j.minimum + (1 - j.minimum) * c;
    return Math.max(j.minimum, controlled * (1 - j.jitter * this.#random()));
  }

  /**
   * The share of the base size the size control alone sets at a placement (no random jitter, so
   * it draws no random numbers): spacing follows it, keeping light-pressure or faded ends joined.
   */
  sizeScale(placement: Placement): number {
    const sh = this.#d.shape;
    if (!sh.enabled) return 1;
    const p = this.#posed(placement);
    if (sh.size.control === 'tilt' && sh.tiltScale > 0)
      return 1 + (sh.tiltScale * Math.min(90, Math.hypot(p.point.tiltX, p.point.tiltY))) / 90;
    return sh.size.minimum + (1 - sh.size.minimum) * this.#control(sh.size.control, sh.size.fadeSteps, p);
  }

  /** The pen at a placement after Brush Pose overrides. */
  #posed(p: Placement): Placement {
    const pose = this.#d.pose;
    if (!pose.enabled) return p;
    return {
      ...p,
      point: {
        ...p.point,
        ...(pose.overrideTilt ? { tiltX: pose.tiltX, tiltY: pose.tiltY } : {}),
        ...(pose.overrideRotation ? { twist: pose.rotation } : {}),
        ...(pose.overridePressure ? { pressure: pose.pressure } : {}),
      },
    };
  }

  /** The dabs for one placement (`base`: the dab without dynamics). */
  apply(base: Dab, placement: Placement): Dab[] {
    const d = this.#d;
    const p = this.#posed(placement);
    const s = d.scatter;
    let count = 1;
    if (s.enabled) {
      count = Math.max(1, s.count);
      if (s.countJitter.jitter > 0 || s.countJitter.control !== 'off')
        count = Math.max(1, Math.round(count * this.#vary(s.countJitter, p)));
    }
    const out: Dab[] = [];
    for (let n = 0; n < count; n++) out.push(this.#one(base, p));
    return out;
  }

  #one(base: Dab, p: Placement): Dab {
    const d = this.#d;
    const dab: Dab = { ...base };
    const sh = d.shape;
    if (sh.enabled) {
      let size = base.size * this.#vary(sh.size, p);
      if (sh.size.control === 'tilt' && sh.tiltScale > 0) {
        // Tilting the pen enlarges the tip by up to Tilt Scale.
        const lean = Math.min(90, Math.hypot(p.point.tiltX, p.point.tiltY)) / 90;
        size = base.size * (1 + sh.tiltScale * lean) * (1 - sh.size.jitter * this.#random());
      }
      dab.size = Math.max(1, size);
      let angle = base.angle;
      switch (sh.angle.control) {
        case 'direction':
          angle += -p.direction * DEG;
          break;
        case 'initial-direction':
          angle += -p.initialDirection * DEG;
          break;
        case 'tilt':
          angle += Math.atan2(-p.point.tiltY, p.point.tiltX) * DEG;
          break;
        case 'rotation':
          angle += p.point.twist;
          break;
        case 'fade':
          angle *= this.#control('fade', sh.angle.fadeSteps, p);
          break;
        case 'pressure':
          angle *= p.point.pressure;
          break;
        case 'wheel':
          angle *= p.point.wheel;
          break;
      }
      angle += sh.angle.jitter * (this.#random() * 2 - 1) * 360;
      dab.angle = ((((angle + 180) % 360) + 360) % 360) - 180;
      dab.roundness = Math.max(0.01, Math.min(1, base.roundness * this.#vary(sh.roundness, p)));
      if (sh.flipXJitter && this.#random() < 0.5) dab.flipX = !dab.flipX;
      if (sh.flipYJitter && this.#random() < 0.5) dab.flipY = !dab.flipY;
    }
    const sc = d.scatter;
    if (sc.enabled && sc.amount > 0) {
      const reach = sc.amount * dab.size * this.#control(sc.control, sc.fadeSteps, p);
      const across = (this.#random() * 2 - 1) * reach;
      const along = sc.bothAxes ? (this.#random() * 2 - 1) * reach : 0;
      const cos = Math.cos(p.direction);
      const sin = Math.sin(p.direction);
      dab.x += cos * along - sin * across;
      dab.y += sin * along + cos * across;
    }
    const tr = d.transfer;
    if (tr.enabled) {
      dab.opacity = (base.opacity ?? this.#opacity) * this.#vary(tr.opacity, p);
      dab.strength *= this.#vary(tr.flow, p);
      const mixer = this.#mixer;
      if (mixer) {
        dab.wet = mixer.wet * this.#vary(tr.wetness, p);
        dab.mix = mixer.mix * this.#vary(tr.mix, p);
      }
    }
    if (d.color.enabled && this.#colors) {
      if (d.color.perTip || !this.#strokeColor) this.#strokeColor = this.#color(p);
      dab.color = this.#strokeColor;
    }
    if (depthVaries(d.texture)) dab.depth = d.texture.depth * this.#vary(d.texture.depthJitter, p);
    return dab;
  }

  /** A varied colour: foreground→background by the FG/BG control and jitter, then hue, saturation, brightness, purity. */
  #color(p: Placement): number[] {
    const c = this.#d.color;
    const { foreground: fg, background: bg, toSamples } = this.#colors!;
    // The control leans towards the background as it falls (e.g. lighter pressure).
    const t = Math.min(
      1,
      Math.max(0, 1 - this.#control(c.fgbg.control, c.fgbg.fadeSteps, p) + c.fgbg.jitter * this.#random()),
    );
    const mixed: RGB = { r: fg.r + (bg.r - fg.r) * t, g: fg.g + (bg.g - fg.g) * t, b: fg.b + (bg.b - fg.b) * t };
    const hsb = rgbToHsb(mixed);
    hsb.h = (((hsb.h + c.hue * (this.#random() * 2 - 1) * 180) % 360) + 360) % 360;
    hsb.s = Math.min(1, Math.max(0, hsb.s + c.saturation * (this.#random() * 2 - 1) + c.purity));
    hsb.b = Math.min(1, Math.max(0, hsb.b + c.brightness * (this.#random() * 2 - 1)));
    return toSamples(hsbToRgb(hsb));
  }
}

/**
 * Turns pointer samples into the dabs of a stroke: spacing, then dynamics (if any).
 * Live painting and replaying a recorded stroke both use it, with the same seed.
 */
export class StrokeDabber {
  readonly #spacer: DabSpacer;
  readonly #dynamics: DabDynamics | null;
  readonly #dual: DualDabber | null;
  readonly #mirror: ReturnType<typeof symmetryCopies> | null;

  /** `symmetry`: every dab is also painted at its mirror images; `mixer`: a Mixer Brush stroke's Wet and Mix. */
  constructor(
    brush: BrushSettings,
    seed: number,
    colors: DynamicsColors | null,
    symmetry: Symmetry | null = null,
    mixer: MixerBase | null = null,
  ) {
    this.#mirror = symmetry?.enabled ? symmetryCopies(symmetry) : null;
    const d = brush.dynamics;
    const dynamics = dynamicsOff(d) ? null : new DabDynamics(d!, seed, colors, brush.opacity, mixer);
    this.#dynamics = dynamics;
    this.#spacer = new DabSpacer(
      brush,
      dynamics && ((placed) => dynamics.sizeScale(placed)),
      d?.buildUp ? BUILD_UP_INTERVAL : 0,
    );
    // The Mixer Brush has no Dual Brush.
    this.#dual = d?.dual.enabled && !mixer ? new DualDabber(brush, d.dual, seed) : null;
  }

  /** The dabs a pointer sample adds: the brush's, then the dual tip's (marked `dual`), and their mirror images. */
  add(p: StrokePoint): Dab[] {
    const placed = this.#spacer.place(p);
    const dyn = this.#dynamics;
    const dabs = dyn ? placed.flatMap((d) => dyn.apply(d.dab, d)) : placed.map((d) => d.dab);
    if (this.#dual) dabs.push(...this.#dual.add(p));
    return this.#mirror ? applySymmetry(dabs, this.#mirror) : dabs;
  }
}

/** The Dual Brush's dabs: its own spacing along the path, scattered and repeated, with its own random numbers. */
class DualDabber {
  readonly #spacer: DabSpacer;
  readonly #dual: BrushDynamics['dual'];
  readonly #size: number;
  readonly #random: () => number;

  constructor(brush: BrushSettings, dual: BrushDynamics['dual'], seed: number) {
    this.#dual = dual;
    this.#size = Math.max(1, dual.size * brush.size);
    this.#spacer = new DabSpacer({
      ...brush,
      size: this.#size,
      spacing: dual.spacing,
      angle: 0,
      roundness: 1,
      flipX: false,
      flipY: false,
      pressureSize: false,
      pressureOpacity: false,
    });
    // A stream apart from the brush's, so changing one never moves the other's dabs.
    this.#random = seededRandom((seed ^ 0x5bd1e995) >>> 0);
  }

  add(p: StrokePoint): Dab[] {
    const d = this.#dual;
    const out: Dab[] = [];
    for (const placed of this.#spacer.place(p)) {
      for (let n = 0; n < d.count; n++) {
        const dab: Dab = { ...placed.dab, strength: 1, dual: true };
        if (d.scatter > 0) {
          const reach = d.scatter * this.#size;
          const across = (this.#random() * 2 - 1) * reach;
          const along = d.bothAxes ? (this.#random() * 2 - 1) * reach : 0;
          const cos = Math.cos(placed.direction);
          const sin = Math.sin(placed.direction);
          dab.x += cos * along - sin * across;
          dab.y += sin * along + cos * across;
        }
        if (d.flip) {
          dab.flipX = this.#random() < 0.5;
          dab.flipY = this.#random() < 0.5;
        }
        out.push(dab);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Reading recorded settings
// ---------------------------------------------------------------------------

const CONTROLS: readonly DynamicsControl[] = [
  'off',
  'fade',
  'pressure',
  'tilt',
  'wheel',
  'rotation',
  'initial-direction',
  'direction',
];

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : {});

function num(raw: Raw, key: string, lo: number, hi: number, fallback: number): number {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
    throw new Error(`brush dynamics: ${key} must be ${lo}–${hi}`);
  return v;
}

const bool = (raw: Raw, key: string, fallback: boolean) => (raw[key] === undefined ? fallback : raw[key] === true);

function control(raw: Raw, key: string, fallback: DynamicsControl): DynamicsControl {
  const v = raw[key] ?? fallback;
  if (!CONTROLS.includes(v as DynamicsControl)) throw new Error(`brush dynamics: unknown control ${JSON.stringify(v)}`);
  return v as DynamicsControl;
}

function controlled(v: unknown, fallback: ControlledJitter): ControlledJitter {
  const raw = obj(v);
  return {
    jitter: num(raw, 'jitter', 0, 1, fallback.jitter),
    control: control(raw, 'control', fallback.control),
    fadeSteps: num(raw, 'fadeSteps', 0, 9999, fallback.fadeSteps),
    minimum: num(raw, 'minimum', 0, 1, fallback.minimum),
  };
}

/** Recorded dynamics (possibly partial, from an Action) checked and completed with the defaults. */
export function parseDynamics(v: unknown): BrushDynamics {
  const raw = obj(v);
  const D = DEFAULT_DYNAMICS;
  const shape = obj(raw['shape']);
  const scatter = obj(raw['scatter']);
  const transfer = obj(raw['transfer']);
  const color = obj(raw['color']);
  const pose = obj(raw['pose']);
  const texture = obj(raw['texture']);
  const dual = obj(raw['dual']);
  const T = D.texture;
  const B = D.dual;
  return {
    shape: {
      enabled: bool(shape, 'enabled', false),
      size: controlled(shape['size'], D.shape.size),
      tiltScale: num(shape, 'tiltScale', 0, 2, D.shape.tiltScale),
      angle: controlled(shape['angle'], D.shape.angle),
      roundness: controlled(shape['roundness'], D.shape.roundness),
      flipXJitter: bool(shape, 'flipXJitter', false),
      flipYJitter: bool(shape, 'flipYJitter', false),
    },
    scatter: {
      enabled: bool(scatter, 'enabled', false),
      amount: num(scatter, 'amount', 0, 10, D.scatter.amount),
      bothAxes: bool(scatter, 'bothAxes', false),
      control: control(scatter, 'control', 'off'),
      fadeSteps: num(scatter, 'fadeSteps', 0, 9999, D.scatter.fadeSteps),
      count: num(scatter, 'count', 1, 16, 1),
      countJitter: controlled(scatter['countJitter'], D.scatter.countJitter),
    },
    transfer: {
      enabled: bool(transfer, 'enabled', false),
      opacity: controlled(transfer['opacity'], D.transfer.opacity),
      flow: controlled(transfer['flow'], D.transfer.flow),
      wetness: controlled(transfer['wetness'], D.transfer.wetness),
      mix: controlled(transfer['mix'], D.transfer.mix),
    },
    color: {
      enabled: bool(color, 'enabled', false),
      perTip: bool(color, 'perTip', true),
      fgbg: controlled(color['fgbg'], D.color.fgbg),
      hue: num(color, 'hue', 0, 1, 0),
      saturation: num(color, 'saturation', 0, 1, 0),
      brightness: num(color, 'brightness', 0, 1, 0),
      purity: num(color, 'purity', -1, 1, 0),
    },
    pose: {
      enabled: bool(pose, 'enabled', false),
      overrideTilt: bool(pose, 'overrideTilt', false),
      tiltX: num(pose, 'tiltX', -90, 90, 0),
      tiltY: num(pose, 'tiltY', -90, 90, 0),
      overrideRotation: bool(pose, 'overrideRotation', false),
      rotation: num(pose, 'rotation', 0, 360, 0),
      overridePressure: bool(pose, 'overridePressure', false),
      pressure: num(pose, 'pressure', 0, 1, 1),
    },
    texture: {
      enabled: bool(texture, 'enabled', false),
      pattern: str(texture, 'pattern', T.pattern),
      invert: bool(texture, 'invert', false),
      scale: num(texture, 'scale', 0.01, 10, T.scale),
      brightness: num(texture, 'brightness', -150, 150, T.brightness),
      contrast: num(texture, 'contrast', -50, 100, T.contrast),
      eachTip: bool(texture, 'eachTip', T.eachTip),
      mode: oneOf(texture, 'mode', TEXTURE_MODES, T.mode),
      depth: num(texture, 'depth', 0, 1, T.depth),
      depthJitter: controlled(texture['depthJitter'], T.depthJitter),
    },
    dual: {
      enabled: bool(dual, 'enabled', false),
      mode: oneOf(dual, 'mode', DUAL_MODES, B.mode),
      flip: bool(dual, 'flip', false),
      tip: dual['tip'] === undefined || dual['tip'] === null ? null : str(dual, 'tip', ''),
      hardness: num(dual, 'hardness', 0, 1, B.hardness),
      size: num(dual, 'size', 0.001, 100, B.size),
      spacing: num(dual, 'spacing', 0.01, 10, B.spacing),
      scatter: num(dual, 'scatter', 0, 10, B.scatter),
      bothAxes: bool(dual, 'bothAxes', false),
      count: num(dual, 'count', 1, 16, B.count),
    },
    noise: bool(raw, 'noise', false),
    wetEdges: bool(raw, 'wetEdges', false),
    buildUp: bool(raw, 'buildUp', false),
  };
}

function str(raw: Raw, key: string, fallback: string): string {
  const v = raw[key] ?? fallback;
  if (typeof v !== 'string' || v === '') throw new Error(`brush dynamics: ${key} must be a name`);
  return v;
}

function oneOf<T extends string>(raw: Raw, key: string, options: readonly [T, string][], fallback: T): T {
  const v = raw[key] ?? fallback;
  if (!options.some(([id]) => id === v)) throw new Error(`brush dynamics: unknown ${key} ${JSON.stringify(v)}`);
  return v as T;
}
