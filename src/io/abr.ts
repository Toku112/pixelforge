/**
 * Importing brush files of the reference app (.abr, versions 6–10, i.e. from its 2003
 * release on) through ag-psd's reader: sampled tips, texture patterns and presets
 * with their Brush Settings sections, mapped onto our brush settings. Runs in the
 * codec worker.
 *
 * What we cannot paint yet is approximated and listed in `notes`: bristle and
 * erodible tips (a round tip of the same size).
 */
import {
  readAbr,
  type Brush as AbrBrush,
  type BrushDynamics as AbrDynamics,
  type BrushShape as AbrShape,
} from 'ag-psd';
import { LAYER_BLEND_MODES, type LayerBlendMode } from '../core/document/layers';
import { DEFAULT_BRUSH, type BrushSettings, type BrushTip } from '../core/paint/brush';
import {
  DEFAULT_DYNAMICS,
  type BrushDynamics,
  type ControlledJitter,
  type DynamicsControl,
} from '../core/paint/dynamics';
import type { BrushBundle, BrushPreset } from '../core/paint/presets';
import type { DualMode, TextureMode } from '../core/paint/texture';
import type { Pattern } from '../core/pattern/pattern';

export interface AbrImport extends BrushBundle {
  /** What was approximated or left out, for the user. */
  notes: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

const CONTROLS: Record<AbrDynamics['control'], DynamicsControl> = {
  off: 'off',
  fade: 'fade',
  'pen pressure': 'pressure',
  'pen tilt': 'tilt',
  'stylus wheel': 'wheel',
  'initial direction': 'initial-direction',
  direction: 'direction',
  'initial rotation': 'rotation',
  rotation: 'rotation',
};

function jitter(d: AbrDynamics | undefined, minimum?: number): ControlledJitter {
  if (!d) return { jitter: 0, control: 'off', fadeSteps: 25, minimum: minimum ?? 0 };
  return {
    jitter: clamp(d.jitter, 0, 1),
    control: CONTROLS[d.control] ?? 'off',
    fadeSteps: clamp(d.steps || 25, 1, 9999),
    minimum: clamp(minimum ?? d.minimum, 0, 1),
  };
}

const TEXTURE_MODES: Record<string, TextureMode> = {
  multiply: 'multiply',
  subtract: 'subtract',
  subtraction: 'subtract',
  darken: 'darken',
  overlay: 'overlay',
  'color dodge': 'color-dodge',
  'color burn': 'color-burn',
  'linear burn': 'linear-burn',
  'hard mix': 'hard-mix',
  'linear height': 'linear-height',
  height: 'height',
};

const DUAL_MODES: Record<string, DualMode> = {
  multiply: 'multiply',
  darken: 'darken',
  overlay: 'overlay',
  'color dodge': 'color-dodge',
  'color burn': 'color-burn',
  'linear burn': 'linear-burn',
  'hard mix': 'hard-mix',
  'linear height': 'linear-height',
};

/** A layer blend mode from ag-psd's name ("color burn" → "color-burn"). */
function layerMode(name: string): LayerBlendMode {
  const id = name.replace(/ /g, '-') as LayerBlendMode;
  return LAYER_BLEND_MODES.includes(id) ? id : 'normal';
}

/** The tip part of a brush from an ABR tip shape (bristle and erodible tips become round ones). */
function tipOf(shape: AbrShape, prefix: string, note: (text: string) => void): Partial<BrushSettings> {
  const common = {
    size: clamp(shape.size, 1, 5000),
    angle: clamp(shape.angle, -180, 180),
    spacing: clamp(shape.spacing, 0.01, 10),
    spacingEnabled: shape.spacingOn !== false,
    flipX: !!shape.flipX,
    flipY: !!shape.flipY,
  };
  switch (shape.type) {
    case 'computed':
      return {
        ...common,
        roundness: clamp(shape.roundness, 0.01, 1),
        hardness: clamp(shape.hardness, 0, 1),
        tip: null,
      };
    case 'sampled':
      return {
        ...common,
        roundness: clamp(shape.roundness, 0.01, 1),
        hardness: 1,
        tip: `${prefix}${shape.sampledData}`,
      };
    default:
      note('bristle and erodible tips are painted with a round tip of the same size');
      return { ...common, roundness: 1, hardness: 0.8, tip: null };
  }
}

function presetOf(b: AbrBrush, id: string, group: string, prefix: string, note: (text: string) => void): BrushPreset {
  const d: BrushDynamics = JSON.parse(JSON.stringify(DEFAULT_DYNAMICS)) as BrushDynamics;
  const tip = tipOf(b.shape, prefix, note);
  const sd = b.shapeDynamics;
  if (sd) {
    d.shape = {
      enabled: true,
      size: jitter(sd.sizeDynamics, sd.minimumDiameter),
      tiltScale: clamp(sd.tiltScale, 0, 2),
      angle: jitter(sd.angleDynamics, 0),
      roundness: jitter(sd.roundnessDynamics, sd.minimumRoundness),
      flipXJitter: !!sd.flipX,
      flipYJitter: !!sd.flipY,
    };
  }
  const sc = b.scatter;
  if (sc) {
    d.scatter = {
      enabled: true,
      amount: clamp(sc.scatterDynamics.jitter, 0, 10),
      bothAxes: !!sc.bothAxes,
      control: CONTROLS[sc.scatterDynamics.control] ?? 'off',
      fadeSteps: clamp(sc.scatterDynamics.steps || 25, 1, 9999),
      count: clamp(Math.round(sc.count || 1), 1, 16),
      countJitter: jitter(sc.countDynamics),
    };
  }
  const tx = b.texture;
  if (tx) {
    d.texture = {
      enabled: true,
      pattern: `${prefix}${tx.id}`,
      invert: !!tx.invert,
      scale: clamp(tx.scale, 0.01, 10),
      brightness: clamp(tx.brightness ?? 0, -150, 150),
      contrast: clamp(tx.contrast ?? 0, -50, 100),
      eachTip: !!tx.textureEachTip,
      mode: TEXTURE_MODES[tx.blendMode] ?? 'multiply',
      depth: clamp(tx.depth, 0, 1),
      depthJitter: jitter(tx.depthDynamics, tx.depthMinimum),
    };
  }
  const db = b.dualBrush;
  if (db) {
    const dualTip = tipOf(db.shape, prefix, note);
    d.dual = {
      enabled: true,
      mode: DUAL_MODES[db.blendMode] ?? 'multiply',
      flip: !!db.flip,
      tip: dualTip.tip ?? null,
      hardness: dualTip.hardness ?? 1,
      size: clamp((dualTip.size ?? 1) / (tip.size ?? 1), 0.001, 100),
      spacing: clamp(db.spacing, 0.01, 10),
      scatter: db.useScatter ? clamp(db.scatterDynamics.jitter, 0, 10) : 0,
      bothAxes: !!db.bothAxes,
      count: clamp(Math.round(db.count || 1), 1, 16),
    };
  }
  const cd = b.colorDynamics;
  if (cd) {
    d.color = {
      enabled: true,
      perTip: cd.perTip !== false,
      fgbg: jitter(cd.foregroundBackground),
      hue: clamp(cd.hue, 0, 1),
      saturation: clamp(cd.saturation, 0, 1),
      brightness: clamp(cd.brightness, 0, 1),
      purity: clamp(cd.purity, -1, 1),
    };
  }
  const tr = b.transfer;
  if (tr) {
    d.transfer = {
      enabled: true,
      opacity: jitter(tr.opacityDynamics),
      flow: jitter(tr.flowDynamics),
      wetness: jitter(tr.wetnessDynamics),
      mix: jitter(tr.mixDynamics),
    };
  }
  const bp = b.brushPose;
  if (bp) {
    d.pose = {
      enabled: true,
      overrideTilt: !!(bp.overrideTiltX || bp.overrideTiltY),
      tiltX: clamp(bp.tiltX ?? 0, -90, 90),
      tiltY: clamp(bp.tiltY ?? 0, -90, 90),
      overrideRotation: !!bp.overrideAngle,
      rotation: clamp((((bp.angle ?? 0) % 360) + 360) % 360, 0, 360),
      overridePressure: !!bp.overridePressure,
      pressure: clamp(bp.pressure, 0, 1),
    };
  }
  d.noise = !!b.noise;
  d.wetEdges = !!b.wetEdges;
  const brush: BrushSettings = { ...DEFAULT_BRUSH, ...tip, dynamics: d };
  const to = b.toolOptions;
  if (to?.brushPreset !== false && to) {
    brush.opacity = clamp(to.opacity / 100, 0.01, 1);
    brush.flow = clamp(to.flow / 100, 0.01, 1);
    brush.mode = layerMode(to.mode);
    brush.pressureSize = !!to.usePressureOverridesSize;
    brush.pressureOpacity = !!to.usePressureOverridesOpacity;
    d.buildUp = false;
    return {
      id,
      name: b.name || 'Brush',
      group,
      brush,
      toolSettings: true,
      smoothing: {
        amount: clamp(to.smoothingValue / 100, 0, 1),
        pulledString: !!to.smoothingRadiusMode,
        catchUp: !!to.smoothingCatchup,
        catchUpOnEnd: !!to.smoothingCatchupAtEnd,
        adjustForZoom: !!to.smoothingZoomCompensation,
      },
    };
  }
  return { id, name: b.name || 'Brush', group, brush, toolSettings: false };
}

/**
 * Reads an .abr file into presets (in `group`), the tips and patterns they use (ids
 * prefixed with `prefix`, so they never clash with ours), and notes.
 */
export function importAbr(bytes: Uint8Array, group: string, prefix: string): AbrImport {
  let abr: ReturnType<typeof readAbr>;
  try {
    abr = readAbr(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/version \((1|2)\)/.test(message))
      throw new Error('This brush file is from a very old version (before 2003), which cannot be read yet', {
        cause: error,
      });
    throw new Error(`This brush file could not be read (${message})`, { cause: error });
  }
  const notes = new Set<string>();
  const note = (text: string) => notes.add(text);
  const tips: BrushTip[] = abr.samples.map((s, i) => ({
    id: `${prefix}${s.id}`,
    name: `${group} ${i + 1}`,
    width: s.bounds.w,
    height: s.bounds.h,
    data: s.alpha,
  }));
  const patterns: Pattern[] = abr.patterns.map((p) => ({
    id: `${prefix}${p.id}`,
    name: p.name || 'Pattern',
    width: p.bounds.w,
    height: p.bounds.h,
    data: p.data,
  }));
  const presets = abr.brushes.map((b, i) => presetOf(b, `${prefix}preset-${i}`, group, prefix, note));
  // Textures whose pattern the file does not carry fall back to our Paper (the user may have it elsewhere).
  const known = new Set(patterns.map((p) => p.id));
  for (const p of presets) {
    const t = p.brush.dynamics!.texture;
    if (t.enabled && !known.has(t.pattern)) {
      t.pattern = 'pf-paper';
      note('textures whose pattern is not in the file use the Paper pattern');
    }
  }
  return { presets, tips, patterns, notes: [...notes] };
}
