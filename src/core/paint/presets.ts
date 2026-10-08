/**
 * Brush presets: named brushes (tip, size and every Brush Settings section) in groups,
 * as the Brushes panel and the brush preset picker show them; our default library;
 * and our brush preset file.
 *
 * Behaviour (own summary of the reference app):
 * - Choosing a preset sets the painting tool's brush. A preset may include the tool's
 *   opacity, flow, mode and smoothing; otherwise the tool keeps its own.
 * - Protect Texture keeps the current texture's pattern and scale when switching to a
 *   preset that has a texture.
 */
import { DEFAULT_BRUSH, type BrushSettings, type BrushTip } from './brush';
import { DEFAULT_DYNAMICS, parseDynamics, type BrushDynamics } from './dynamics';
import type { SmoothingOptions } from './smoothing';
import type { Pattern } from '../pattern/pattern';

/** A copy of plain data (presets hold only JSON values). */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface BrushPreset {
  id: string;
  name: string;
  /** Group (folder) name, or null for presets outside any group. */
  group: string | null;
  brush: BrushSettings;
  /** The preset includes the tool's opacity, flow, mode (in `brush`) and smoothing. */
  toolSettings: boolean;
  smoothing?: Partial<SmoothingOptions>;
}

/** The brush a preset gives the tool, from the tool's current brush. */
export function applyPreset(current: BrushSettings, preset: BrushPreset, protectTexture = false): BrushSettings {
  const next: BrushSettings = clone(preset.brush);
  const dynamics = (next.dynamics ??= clone(DEFAULT_DYNAMICS));
  if (!preset.toolSettings) {
    next.opacity = current.opacity;
    next.flow = current.flow;
    next.mode = current.mode;
  }
  const kept = current.dynamics?.texture;
  if (protectTexture && kept && dynamics.texture.enabled) {
    dynamics.texture = { ...dynamics.texture, pattern: kept.pattern, scale: kept.scale };
  }
  return next;
}

/** A new preset from the tool's brush (and, with `toolSettings`, its smoothing). */
export function presetFromBrush(
  id: string,
  name: string,
  group: string | null,
  brush: BrushSettings,
  smoothing: SmoothingOptions | null,
): BrushPreset {
  return {
    id,
    name,
    group,
    brush: clone(brush),
    toolSettings: smoothing !== null,
    ...(smoothing ? { smoothing: { ...smoothing } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Our default brush library
// ---------------------------------------------------------------------------

type DynamicsChanges = {
  [K in keyof BrushDynamics]?: BrushDynamics[K] extends object ? Partial<BrushDynamics[K]> : BrushDynamics[K];
};

function brush(base: Partial<BrushSettings>, dyn: DynamicsChanges = {}): BrushSettings {
  const d = clone(DEFAULT_DYNAMICS);
  for (const [key, value] of Object.entries(dyn) as [keyof BrushDynamics, unknown][]) {
    if (typeof value === 'object' && value !== null) Object.assign(d[key] as object, value);
    else (d as unknown as Record<string, unknown>)[key] = value;
  }
  return { ...DEFAULT_BRUSH, ...base, dynamics: d };
}

const j = (
  jitter: number,
  control: BrushDynamics['shape']['size']['control'] = 'off',
  minimum = 0,
  fadeSteps = 25,
) => ({
  jitter,
  control,
  minimum,
  fadeSteps,
});

/** Our default presets, by group (ids stay the same so restoring them replaces them). */
export function defaultPresets(): BrushPreset[] {
  const p = (id: string, name: string, group: string, b: BrushSettings, toolSettings = false): BrushPreset => ({
    id: `pf-${id}`,
    name,
    group,
    brush: b,
    toolSettings,
  });
  const G = 'General Brushes';
  const D = 'Dry Media';
  const W = 'Wet Media';
  const S = 'Special Effects';
  return [
    p('hard-round', 'Hard Round', G, brush({ size: 30, hardness: 1 })),
    p('soft-round', 'Soft Round', G, brush({ size: 45, hardness: 0 })),
    p(
      'hard-round-size',
      'Hard Round Pressure Size',
      G,
      brush({ size: 30 }, { shape: { enabled: true, size: j(0, 'pressure') } }),
    ),
    p(
      'soft-round-opacity',
      'Soft Round Pressure Opacity',
      G,
      brush({ size: 45, hardness: 0 }, { transfer: { enabled: true, opacity: j(0, 'pressure') } }),
    ),
    p(
      'hard-round-opacity-flow',
      'Hard Round Pressure Opacity and Flow',
      G,
      brush({ size: 30 }, { transfer: { enabled: true, opacity: j(0, 'pressure'), flow: j(0, 'pressure') } }),
    ),
    p(
      'sketch-pencil',
      'Sketch Pencil',
      D,
      brush(
        { size: 5, hardness: 0.9 },
        {
          shape: { enabled: true, size: j(0, 'pressure', 0.35) },
          texture: { enabled: true, pattern: 'pf-grain', eachTip: true, depth: 0.55, scale: 0.6 },
        },
      ),
    ),
    p(
      'charcoal',
      'Charcoal',
      D,
      brush(
        { size: 40, tip: 'pf-tip-charcoal', spacing: 0.15 },
        {
          shape: { enabled: true, size: j(0.15, 'pressure', 0.3), angle: j(0.08) },
          scatter: { enabled: true, amount: 0.15 },
          texture: { enabled: true, pattern: 'pf-rough-paper', eachTip: true, depth: 0.7, mode: 'subtract' },
        },
      ),
    ),
    p(
      'chalk',
      'Soft Pastel',
      D,
      brush(
        { size: 36, tip: 'pf-tip-chalk', spacing: 0.2 },
        {
          shape: { enabled: true, angle: j(1) },
          texture: { enabled: true, pattern: 'pf-paper', depth: 0.6 },
          transfer: { enabled: true, opacity: j(0.1, 'pressure') },
        },
      ),
    ),
    p(
      'crayon',
      'Crayon',
      D,
      brush(
        { size: 14, hardness: 0.8, roundness: 0.7, angle: 40 },
        {
          texture: { enabled: true, pattern: 'pf-canvas', depth: 0.8, mode: 'height', scale: 0.5 },
          shape: { enabled: true, size: j(0, 'pressure', 0.5) },
        },
      ),
    ),
    p(
      'watercolor',
      'Watercolor Wash',
      W,
      brush(
        { size: 60, hardness: 0, flow: 0.35, spacing: 0.1 },
        {
          wetEdges: true,
          texture: { enabled: true, pattern: 'pf-paper', depth: 0.35, eachTip: true },
          transfer: { enabled: true, flow: j(0.1, 'pressure') },
        },
      ),
      true,
    ),
    p(
      'ink',
      'Ink Pen',
      W,
      brush({ size: 8, hardness: 1, spacing: 0.1 }, { shape: { enabled: true, size: j(0, 'pressure', 0.1) } }),
    ),
    p(
      'gouache',
      'Flat Gouache',
      W,
      brush(
        { size: 30, hardness: 0.85, roundness: 0.3, angle: 35, spacing: 0.08 },
        {
          dual: { enabled: true, tip: 'pf-tip-bristle', size: 1.1, spacing: 0.15, mode: 'multiply' },
          shape: { enabled: true, angle: j(0, 'direction') },
        },
      ),
    ),
    p(
      'bristle',
      'Dry Bristle',
      W,
      brush(
        { size: 50, tip: 'pf-tip-bristle', spacing: 0.05 },
        {
          shape: { enabled: true, angle: j(0, 'direction') },
          transfer: { enabled: true, opacity: j(0.2, 'pressure') },
        },
      ),
    ),
    p(
      'spatter',
      'Spatter',
      S,
      brush(
        { size: 60, tip: 'pf-tip-spatter', spacing: 0.6 },
        {
          shape: { enabled: true, size: j(0.5), angle: j(1) },
          scatter: { enabled: true, amount: 2, bothAxes: true, count: 2 },
        },
      ),
    ),
    p(
      'stars',
      'Stars',
      S,
      brush(
        { size: 30, tip: 'pf-tip-star', spacing: 1.2 },
        {
          shape: { enabled: true, size: j(0.7, 'off', 0.2), angle: j(0.25) },
          scatter: { enabled: true, amount: 2.5, bothAxes: true },
          color: { enabled: true, hue: 0.25, brightness: 0.2 },
        },
      ),
    ),
    p(
      'leaves',
      'Scattered Leaves',
      S,
      brush(
        { size: 40, tip: 'pf-tip-leaf', spacing: 0.9 },
        {
          shape: { enabled: true, size: j(0.5, 'off', 0.3), angle: j(1), flipXJitter: true },
          scatter: { enabled: true, amount: 1.5, bothAxes: true, count: 2 },
          color: { enabled: true, fgbg: j(1), hue: 0.08, brightness: 0.15 },
        },
      ),
    ),
    p(
      'grass',
      'Grass',
      S,
      brush(
        { size: 60, tip: 'pf-tip-grass', spacing: 0.25 },
        {
          shape: { enabled: true, size: j(0.4, 'pressure', 0.3), angle: j(0.06) },
          scatter: { enabled: true, amount: 0.5, count: 2 },
          color: { enabled: true, fgbg: j(1), hue: 0.05, brightness: 0.1 },
        },
      ),
    ),
    p('dotted', 'Dotted Line', S, brush({ size: 8, hardness: 1, spacing: 2 })),
    p(
      'clouds',
      'Clouds',
      S,
      brush(
        { size: 120, hardness: 0, spacing: 0.3, flow: 0.2 },
        {
          shape: { enabled: true, size: j(0.6, 'off', 0.3) },
          scatter: { enabled: true, amount: 0.8, bothAxes: true },
          texture: { enabled: true, pattern: 'pf-rough-paper', depth: 0.5, scale: 3 },
        },
      ),
      true,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Presets in files and storage (the file itself: io/brush-file.ts)
// ---------------------------------------------------------------------------

export interface BrushBundle {
  presets: BrushPreset[];
  /** The sampled tips the presets use (not the built-in ones). */
  tips: BrushTip[];
  /** The texture patterns the presets use (not the built-in ones). */
  patterns: Pattern[];
}

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A preset from a file or storage, checked and completed with defaults. */
export function parsePreset(raw: unknown): BrushPreset {
  if (!isRaw(raw) || typeof raw['id'] !== 'string' || typeof raw['name'] !== 'string' || !isRaw(raw['brush']))
    throw new Error('Brush file: a preset is damaged');
  const b = raw['brush'];
  const num = (key: string, lo: number, hi: number, fallback: number) => {
    const v = b[key];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  };
  const D = DEFAULT_BRUSH;
  const brushSettings: BrushSettings = {
    size: num('size', 1, 5000, D.size),
    hardness: num('hardness', 0, 1, D.hardness),
    opacity: num('opacity', 0.01, 1, D.opacity),
    flow: num('flow', 0.01, 1, D.flow),
    spacing: num('spacing', 0.01, 10, D.spacing),
    spacingEnabled: b['spacingEnabled'] !== false,
    pressureSize: b['pressureSize'] === true,
    pressureOpacity: b['pressureOpacity'] === true,
    angle: num('angle', -180, 180, D.angle),
    roundness: num('roundness', 0.01, 1, D.roundness),
    flipX: b['flipX'] === true,
    flipY: b['flipY'] === true,
    tip: typeof b['tip'] === 'string' ? b['tip'] : null,
    mode: typeof b['mode'] === 'string' ? (b['mode'] as BrushSettings['mode']) : 'normal',
    dynamics: parseDynamics(b['dynamics'] ?? {}),
  };
  return {
    id: raw['id'],
    name: raw['name'],
    group: typeof raw['group'] === 'string' ? raw['group'] : null,
    brush: brushSettings,
    toolSettings: raw['toolSettings'] === true,
    ...(isRaw(raw['smoothing']) ? { smoothing: raw['smoothing'] } : {}),
  };
}
