import { describe, expect, it } from 'vitest';
import { ImageDocument } from '../../../src/core/document/document';
import { DEFAULT_MIXER, INITIAL_MIXER, solidPaint, type MixerBrushState } from '../../../src/core/paint/mixer';
import { Viewport } from '../../../src/engine/viewport/viewport';
import { MIXER_CURSOR, MIXER_LOAD_CURSOR } from '../../../src/tools/paint/cursors';
import { createTools } from '../../../src/tools/registry';
import {
  DEFAULT_CURSOR_PREFERENCES,
  type MixerBegin,
  type PaintHost,
  type PaintStroke,
  type ToolContext,
  type ToolPointerEvent,
} from '../../../src/tools/types';

/** A 40 × 30 document at 100 %; the paint host records the strokes begun (and may refuse them). */
function setup() {
  const doc = new ImageDocument({ width: 40, height: 30 });
  const bg = doc.createBackgroundLayer();
  doc.insertLayer(bg);
  doc.setActiveLayer(bg.id);
  const viewport = new Viewport({ viewWidth: 40, viewHeight: 30, zoom: 1, centerX: 20, centerY: 15 });
  const begun: MixerBegin[] = [];
  const loads: { at: { x: number; y: number }; size: number; allLayers: boolean; solid: boolean }[] = [];
  let refuse = false;
  const stroke: PaintStroke = {
    seed: 1,
    colors: null,
    symmetry: null,
    add: () => {},
    end: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
  };
  const paint: PaintHost = {
    begin: (_tool, _brush, options) => {
      if (refuse) return null;
      if (options?.mixer) begun.push(options.mixer);
      return stroke;
    },
    loadMixer: (at, size, allLayers, solid) => {
      loads.push({ at, size, allLayers, solid });
      return Promise.resolve({
        kind: 'sample',
        mode: 'rgb',
        paint: solidPaint([0, 1, 0], 'u16'),
        preview: { width: 1, height: 1, rgba: new Uint8Array([0, 255, 0, 255]) },
      });
    },
  };
  const ctx: ToolContext = {
    viewport,
    document: doc,
    devicePixelRatio: 1,
    viewChanged: () => {},
    setOverlayRect: () => {},
    setSelectionPreview: () => {},
    execute: () => {},
    paint,
    setBrushOutline: () => {},
    setCropBox: () => {},
    setTransformBox: () => {},
    preview: () => {},
    selectLayers: () => {},
    report: () => {},
    cursorPreferences: DEFAULT_CURSOR_PREFERENCES,
    setBrushHud: () => {},
    toolOptionsChanged: () => {},
    showSymmetry: () => {},
    setSymmetryEdit: () => {},
    colors: {
      sample: () => Promise.resolve(null),
      get: () => ({ r: 0, g: 0, b: 0 }),
      set: () => {},
      eyedropper: { sampleSize: 1, source: 'all', showRing: false },
    },
    setSampleRing: () => {},
    setGradientLine: () => {},
  };
  const tool = createTools().mixerBrush;
  return { tool, ctx, begun, loads, refuse: (on: boolean) => (refuse = on) };
}

const ev = (x: number, y: number, mods: Partial<ToolPointerEvent> = {}): ToolPointerEvent => ({
  x,
  y,
  shiftKey: false,
  altKey: false,
  primaryKey: false,
  spaceKey: false,
  pressure: 1,
  ...mods,
});

function drag(tool: ReturnType<typeof setup>['tool'], ctx: ToolContext, mods: Partial<ToolPointerEvent> = {}) {
  tool.onPointerDown(ev(5, 5, mods), ctx);
  tool.onPointerMove(ev(20, 5, mods), ctx);
  tool.onPointerUp(ev(20, 5, mods), ctx);
}

const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return done;
};

describe('the Mixer Brush tool', () => {
  it('shares B with the Brush and Pencil, and starts wet, loaded and cleaned after each stroke', () => {
    const tools = createTools();
    const group = tools.groups.find((g) => g.tools.includes(tools.mixerBrush))!;
    expect(group.tools.map((t) => t.id)).toEqual(['brush', 'pencil', 'mixer-brush']);
    expect(tools.mixerBrush.key).toBe('B');
    expect(tools.mixerBrush.mixer).toEqual(DEFAULT_MIXER);
    expect(DEFAULT_MIXER).toMatchObject({ wet: 1, load: 0.5, mix: 0.5, loadAfterStroke: true, cleanAfterStroke: true });
    expect(tools.mixerBrush.mixerState).toBe(INITIAL_MIXER);
  });

  it('starts a stroke only once the stroke before has handed on what the brush holds', async () => {
    const { tool, ctx, begun } = setup();
    tool.setMixer({ loadAfterStroke: false, cleanAfterStroke: false });
    drag(tool, ctx);
    drag(tool, ctx);
    expect(begun).toHaveLength(2);
    expect(await begun[0]!.state).toBe(INITIAL_MIXER);
    expect(await settled(begun[1]!.state)).toBe(false); // waits for the first
    const pickup = solidPaint([0.2, 0.2, 0.2], 'u16');
    begun[0]!.finish({ level: 0.4, pickup }, 'rgb');
    const second: MixerBrushState = await begun[1]!.state;
    expect(second.level).toBe(0.4);
    expect(second.pickup?.paint).toBe(pickup);
  });

  it('cleans and reloads after each stroke as set', async () => {
    const { tool, ctx, begun } = setup();
    drag(tool, ctx);
    begun[0]!.finish({ level: 0.2, pickup: solidPaint([0, 0, 0], 'u16') }, 'rgb');
    await tool.mixerSettled();
    expect(tool.mixerState).toMatchObject({ level: 1, pickup: null });
    tool.setMixer({ loadAfterStroke: false });
    drag(tool, ctx);
    begun[1]!.finish({ level: 0.2, pickup: null }, 'rgb');
    await tool.mixerSettled();
    expect(tool.mixerState.level).toBe(0); // clean, not loaded: a smudging brush
    // A stroke that was not recorded leaves what the brush holds.
    drag(tool, ctx);
    begun[2]!.finish(null, 'rgb');
    await tool.mixerSettled();
    expect(tool.mixerState.level).toBe(0);
  });

  it('Alt-click loads the brush from the image under the tip', async () => {
    const { tool, ctx, loads, begun } = setup();
    tool.setOptions({ size: 12 });
    tool.setMixer({ sampleAllLayers: true });
    expect(tool.cursor({ altKey: true, paintCursor: 'normal' } as never)).toBe(MIXER_LOAD_CURSOR);
    expect(tool.cursor({ altKey: false, paintCursor: 'standard' } as never)).toBe(MIXER_CURSOR);
    tool.cleanBrush();
    tool.onPointerDown(ev(10, 8, { altKey: true }), ctx);
    tool.onPointerUp(ev(10, 8, { altKey: true }), ctx);
    expect(begun).toHaveLength(0); // no stroke
    await tool.mixerSettled();
    expect(loads).toEqual([{ at: { x: 10, y: 8 }, size: 12, allLayers: true, solid: false }]);
    expect(tool.mixerState.load.kind).toBe('sample');
    expect(tool.mixerState.level).toBe(1);
    // Load Brush (and a new foreground colour) goes back to the foreground colour.
    tool.loadForeground();
    await tool.mixerSettled();
    expect(tool.mixerState.load).toEqual({ kind: 'foreground' });
  });

  it('keeps going when a stroke cannot start', async () => {
    const { tool, ctx, begun, refuse } = setup();
    refuse(true);
    drag(tool, ctx);
    refuse(false);
    drag(tool, ctx);
    expect(await settled(begun[0]!.state)).toBe(true);
  });

  it('keeps its options in tool presets', () => {
    const { tool } = setup();
    tool.setMixer({ wet: 0.25, load: 0.75, mix: 0.1, solidOnly: true });
    const saved = tool.presetOptions();
    const other = setup().tool;
    other.applyPresetOptions(saved);
    expect(other.mixer).toMatchObject({ wet: 0.25, load: 0.75, mix: 0.1, solidOnly: true });
  });
});
