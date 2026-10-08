import { describe, expect, it } from 'vitest';
import { ImageDocument } from '../../../src/core/document/document';
import { Viewport } from '../../../src/engine/viewport/viewport';
import { HandTool, viewActions } from '../../../src/tools/hand/hand-tool';
import { RotateViewTool, resetView } from '../../../src/tools/rotate-view/rotate-view-tool';
import {
  DEFAULT_CURSOR_PREFERENCES,
  type ToolContext,
  type ToolPointerEvent,
  type ViewRect,
} from '../../../src/tools/types';
import { ZoomTool } from '../../../src/tools/zoom/zoom-tool';

function setup(zoom = 1) {
  const viewport = new Viewport({ viewWidth: 800, viewHeight: 600, zoom, centerX: 2000, centerY: 1500 });
  const overlays: (ViewRect | null)[] = [];
  let changes = 0;
  const ctx: ToolContext = {
    viewport,
    document: new ImageDocument({ width: 4000, height: 3000 }),
    devicePixelRatio: 1,
    viewChanged: () => changes++,
    setOverlayRect: (r) => overlays.push(r),
    setSelectionPreview: () => {},
    execute: () => {},
    paint: null,
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
    colors: null,
    setSampleRing: () => {},
  };
  return { viewport, ctx, overlays, changes: () => changes };
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

describe('Hand tool', () => {
  it('moves the view with the drag', () => {
    const { viewport, ctx, changes } = setup();
    const tool = new HandTool();
    const before = viewport.viewToDoc({ x: 100, y: 100 });
    tool.onPointerDown(ev(100, 100));
    tool.onPointerMove(ev(130, 90), ctx);
    tool.onPointerMove(ev(150, 80), ctx);
    tool.onPointerUp();
    const after = viewport.docToView(before);
    expect(after.x).toBeCloseTo(150);
    expect(after.y).toBeCloseTo(80);
    expect(changes()).toBe(2);
    tool.onPointerMove(ev(500, 500), ctx); // not dragging any more
    expect(changes()).toBe(2);
    expect(tool.cursor({ altKey: false, dragging: false })).toBe('grab');
    expect(tool.cursor({ altKey: false, dragging: true })).toBe('grabbing');
  });

  it('provides 100 %, Fit Screen and Fill Screen', () => {
    const { viewport, ctx } = setup(0.3);
    viewActions.actualPixels(ctx);
    expect(viewport.zoom).toBe(1);
    viewActions.fitOnScreen(ctx, 0);
    expect(viewport.zoom).toBeCloseTo(0.2);
    viewActions.fillScreen(ctx);
    expect(viewport.zoom).toBeCloseTo(0.2); // 4:3 document in a 4:3 view
  });
});

describe('Zoom tool', () => {
  it('zooms in one step on click and out with Alt, keeping the clicked point in place', () => {
    const { viewport, ctx } = setup();
    const tool = new ZoomTool();
    const doc = viewport.viewToDoc({ x: 200, y: 150 });
    tool.onPointerDown(ev(200, 150));
    tool.onPointerUp(ev(200, 150), ctx);
    expect(viewport.zoom).toBe(2);
    const p = viewport.docToView(doc);
    expect(p.x).toBeCloseTo(200);
    expect(p.y).toBeCloseTo(150);
    tool.onPointerDown(ev(200, 150, { altKey: true }));
    tool.onPointerUp(ev(200, 150, { altKey: true }), ctx);
    expect(viewport.zoom).toBe(1);
    expect(tool.cursor({ altKey: false, dragging: false })).toBe('zoom-in');
    expect(tool.cursor({ altKey: true, dragging: false })).toBe('zoom-out');
  });

  it('zoom-out mode swaps click and Alt-click', () => {
    const { viewport, ctx } = setup();
    const tool = new ZoomTool();
    tool.options.mode = 'out';
    tool.onPointerDown(ev(400, 300));
    tool.onPointerUp(ev(400, 300), ctx);
    expect(viewport.zoom).toBeCloseTo(0.6667, 4);
  });

  it('scrubby zoom: dragging right zooms in continuously around the start point', () => {
    const { viewport, ctx } = setup();
    const tool = new ZoomTool();
    const anchorDoc = viewport.viewToDoc({ x: 300, y: 300 });
    tool.onPointerDown(ev(300, 300));
    tool.onPointerMove(ev(375, 300), ctx);
    tool.onPointerMove(ev(450, 300), ctx); // +150 px → ×2 in total
    tool.onPointerUp(ev(450, 300), ctx);
    expect(viewport.zoom).toBeCloseTo(2, 6);
    const p = viewport.docToView(anchorDoc);
    expect(p.x).toBeCloseTo(300);
    expect(p.y).toBeCloseTo(300);
  });

  it('marquee zoom (scrubby off) fits the dragged rectangle', () => {
    const { viewport, ctx, overlays } = setup();
    const tool = new ZoomTool();
    tool.options.scrubby = false;
    const centerDoc = viewport.viewToDoc({ x: 250, y: 200 });
    tool.onPointerDown(ev(150, 125));
    tool.onPointerMove(ev(350, 275), ctx);
    tool.onPointerUp(ev(350, 275), ctx);
    expect(overlays.at(0)).toEqual({ x: 150, y: 125, w: 200, h: 150 });
    expect(overlays.at(-1)).toBeNull();
    expect(viewport.zoom).toBeCloseTo(4); // 800/200 = 600/150 = 4
    expect(viewport.centerX).toBeCloseTo(centerDoc.x);
    expect(viewport.centerY).toBeCloseTo(centerDoc.y);
  });

  it('treats a tiny movement as a click', () => {
    const { viewport, ctx } = setup();
    const tool = new ZoomTool();
    tool.onPointerDown(ev(100, 100));
    tool.onPointerMove(ev(102, 101), ctx);
    tool.onPointerUp(ev(102, 101), ctx);
    expect(viewport.zoom).toBe(2);
  });
});

describe('Rotate View tool', () => {
  it('rotates with the pointer around the view centre, snapping to 15° with Shift', () => {
    const { viewport, ctx } = setup();
    const tool = new RotateViewTool();
    tool.onPointerDown(ev(600, 300), ctx); // to the right of centre (400, 300): 0°
    tool.onPointerMove(ev(400, 500), ctx); // straight below: +90°
    expect(viewport.rotation).toBeCloseTo(90);
    tool.onPointerMove(ev(500, 400, { shiftKey: true }), ctx); // 45° → stays 45 (multiple of 15)
    expect(viewport.rotation).toBeCloseTo(45);
    tool.onPointerMove(ev(600, 360, { shiftKey: true }), ctx); // ≈16.7° → 15°
    expect(viewport.rotation).toBe(15);
    tool.onPointerUp();
    // The view centre stays on the same document point.
    expect(viewport.centerX).toBeCloseTo(2000);
    resetView(ctx);
    expect(viewport.rotation).toBe(0);
  });

  it('restores the starting angle when cancelled', () => {
    const { viewport, ctx } = setup();
    const tool = new RotateViewTool();
    tool.onPointerDown(ev(600, 300), ctx);
    tool.onPointerMove(ev(400, 500), ctx);
    tool.cancel(ctx);
    expect(viewport.rotation).toBe(0);
  });
});
