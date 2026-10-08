import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../../../src/core/commands/command';
import { ImageDocument } from '../../../src/core/document/document';
import type { Mat3 } from '../../../src/core/geometry/transform';
import { Viewport } from '../../../src/engine/viewport/viewport';
import { TransformTool } from '../../../src/tools/transform/transform-tool';
import {
  DEFAULT_CURSOR_PREFERENCES,
  type ToolContext,
  type ToolPointerEvent,
  type TransformBoxOverlay,
} from '../../../src/tools/types';

/** A 400 × 300 document at 100 %, document (0, 0) at view (0, 0); a box over (100, 100)–(200, 150). */
function setup() {
  const viewport = new Viewport({ viewWidth: 400, viewHeight: 300, zoom: 1, centerX: 200, centerY: 150 });
  const boxes: (TransformBoxOverlay | null)[] = [];
  const previews: Mat3[] = [];
  const finished: (CommandDescriptor | null)[] = [];
  const ctx: ToolContext = {
    viewport,
    document: new ImageDocument({ width: 400, height: 300 }),
    devicePixelRatio: 1,
    viewChanged: () => {},
    setOverlayRect: () => {},
    setSelectionPreview: () => {},
    execute: () => {},
    paint: null,
    setBrushOutline: () => {},
    setCropBox: () => {},
    setTransformBox: (b) => boxes.push(b),
    preview: () => {},
    selectLayers: () => {},
    report: () => {},
    cursorPreferences: DEFAULT_CURSOR_PREFERENCES,
    setBrushHud: () => {},
    toolOptionsChanged: () => {},
    showSymmetry: () => {},
    setSymmetryEdit: () => {},
    colors: null,
    setSampleRing: () => {},
    setGradientLine: () => {},
  };
  const tool = new TransformTool();
  tool.begin(
    ctx,
    { x: 100, y: 100, w: 100, h: 50 },
    {
      preview: (m) => previews.push(m),
      finish: (d) => finished.push(d),
    },
  );
  return { ctx, tool, boxes, previews, finished };
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

function drag(tool: TransformTool, ctx: ToolContext, from: [number, number], to: [number, number], mods = {}) {
  tool.onPointerDown(ev(...from, mods), ctx);
  tool.onPointerMove(ev((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, mods), ctx);
  tool.onPointerUp(ev(...to, mods), ctx);
}

const corners = (tool: TransformTool) =>
  tool.quad!.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]);

describe('Free Transform tool', () => {
  it('shows the box with 8 handles and starts unchanged', () => {
    const { tool, boxes } = setup();
    expect(boxes.at(-1)!.handles).toHaveLength(8);
    expect(tool.parts).toEqual({ scaleX: 1, scaleY: 1, angle: 0, skewH: 0, skewV: 0 });
    expect(tool.busy()).toBe(true);
  });

  it('scales proportionally from a corner by default; Shift frees it; Alt scales about the centre', () => {
    const { ctx, tool } = setup();
    drag(tool, ctx, [200, 150], [250, 150]); // right only
    expect(corners(tool)).toEqual([
      [100, 100],
      [250, 100],
      [250, 175],
      [100, 175],
    ]);
    drag(tool, ctx, [250, 175], [250, 200], { shiftKey: true }); // down only, not proportional
    expect(tool.parts!.scaleX).toBeCloseTo(1.5);
    expect(tool.parts!.scaleY).toBeCloseTo(2);
    const { ctx: c2, tool: t2 } = setup();
    drag(t2, c2, [200, 125], [220, 125], { altKey: true, shiftKey: true }); // right side, from the centre
    expect(corners(t2)).toEqual([
      [80, 100],
      [220, 100],
      [220, 150],
      [80, 150],
    ]);
  });

  it('moves from inside, rotates from outside (Shift: 15° steps), and distorts with Ctrl/Cmd', () => {
    const { ctx, tool, previews } = setup();
    drag(tool, ctx, [150, 125], [160, 130]);
    expect(corners(tool)[0]).toEqual([110, 105]);
    expect(tool.reference).toEqual({ x: 160, y: 130 });
    // From outside on the right, swing about the centre (160, 130) by about 40°: snapped to 45°.
    const r = 100;
    drag(tool, ctx, [160 + r, 130], [160 + r * Math.cos(0.7), 130 + r * Math.sin(0.7)], { shiftKey: true });
    expect(tool.parts!.angle).toBeCloseTo(45);
    expect(previews.length).toBeGreaterThan(2);
    const { ctx: c2, tool: t2 } = setup();
    drag(t2, c2, [200, 100], [230, 80], { primaryKey: true });
    expect(corners(t2)).toEqual([
      [100, 100],
      [230, 80],
      [200, 150],
      [100, 150],
    ]);
  });

  it('typed numbers change the box about the reference point; the link keeps proportions', () => {
    const { ctx, tool } = setup();
    tool.setNumbers({ scaleX: 2 }, ctx);
    expect(corners(tool)).toEqual([
      [50, 75],
      [250, 75],
      [250, 175],
      [50, 175],
    ]);
    tool.setNumbers({ angle: 90 }, ctx);
    expect(tool.parts!.angle).toBeCloseTo(90);
    tool.setNumbers({ x: 200, y: 100 }, ctx);
    expect(tool.reference!.x).toBeCloseTo(200);
    expect(tool.reference!.y).toBeCloseTo(100);
  });

  it('Enter applies (nothing when unchanged); Escape cancels', () => {
    const a = setup();
    expect(a.tool.onKeyDown('Enter', a.ctx)).toBe(true);
    expect(a.finished).toEqual([null]);
    expect(a.tool.active).toBe(false);
    expect(a.boxes.at(-1)).toBeNull();
    const b = setup();
    drag(b.tool, b.ctx, [150, 125], [160, 125]);
    b.tool.onKeyDown('Enter', b.ctx);
    expect(b.finished[0]).toEqual({
      name: 'freeTransform',
      params: { matrix: [1, 0, 10, 0, 1, 0, 0, 0, 1], interpolation: 'automatic' },
    });
    const c = setup();
    drag(c.tool, c.ctx, [150, 125], [160, 125]);
    c.tool.onKeyDown('Escape', c.ctx);
    expect(c.finished).toEqual([null]);
  });
});
