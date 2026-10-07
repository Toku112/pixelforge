import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../../../src/core/commands/command';
import { ImageDocument } from '../../../src/core/document/document';
import { Viewport } from '../../../src/engine/viewport/viewport';
import { CropTool, cropHitTest, drawCropRect, fitRatio, resizeCropRect } from '../../../src/tools/crop/crop-tool';
import type { CropBoxOverlay, ToolContext, ToolPointerEvent } from '../../../src/tools/types';

/** A 400 × 300 document shown at 100 %, document (0, 0) at view (0, 0). */
function setup() {
  const viewport = new Viewport({ viewWidth: 400, viewHeight: 300, zoom: 1, centerX: 200, centerY: 150 });
  const shown: (CropBoxOverlay | null)[] = [];
  const executed: CommandDescriptor[] = [];
  const ctx: ToolContext = {
    viewport,
    document: new ImageDocument({ width: 400, height: 300 }),
    devicePixelRatio: 1,
    viewChanged: () => {},
    setOverlayRect: () => {},
    setSelectionPreview: () => {},
    execute: (d) => executed.push(d),
    paint: null,
    setBrushOutline: () => {},
    setCropBox: (box) => shown.push(box),
    preview: () => {},
    selectLayers: () => {},
    report: () => {},
  };
  const tool = new CropTool();
  tool.activate(ctx);
  return { ctx, tool, shown, executed, last: () => shown.at(-1) };
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

function drag(tool: CropTool, ctx: ToolContext, from: [number, number], to: [number, number], mods = {}) {
  tool.onPointerDown(ev(...from, mods), ctx);
  tool.onPointerMove(ev((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, mods), ctx);
  tool.onPointerUp(ev(...to, mods), ctx);
}

describe('crop box geometry', () => {
  const box = { x: 10, y: 20, w: 100, h: 50 };

  it('finds handles, edges and the inside', () => {
    expect(cropHitTest(box, { x: 11, y: 19 }, 4)).toBe('nw');
    expect(cropHitTest(box, { x: 110, y: 70 }, 4)).toBe('se');
    expect(cropHitTest(box, { x: 60, y: 22 }, 4)).toBe('n');
    expect(cropHitTest(box, { x: 108, y: 40 }, 4)).toBe('e');
    expect(cropHitTest(box, { x: 60, y: 45 }, 4)).toBe('inside');
    expect(cropHitTest(box, { x: 200, y: 45 }, 4)).toBeNull();
  });

  it('draws boxes freely, with a ratio, and from the centre', () => {
    expect(drawCropRect({ x: 50, y: 50 }, { x: 10, y: 20 }, null, false)).toEqual({ x: 10, y: 20, w: 40, h: 30 });
    expect(drawCropRect({ x: 0, y: 0 }, { x: 40, y: 10 }, 1, false)).toEqual({ x: 0, y: 0, w: 40, h: 40 });
    expect(drawCropRect({ x: 50, y: 50 }, { x: 60, y: 55 }, null, true)).toEqual({ x: 40, y: 45, w: 20, h: 10 });
  });

  it('resizes from a handle, keeping the opposite side (or the centre) in place', () => {
    expect(resizeCropRect(box, 'se', 10, 5, null, false)).toEqual({ x: 10, y: 20, w: 110, h: 55 });
    expect(resizeCropRect(box, 'w', 10, 99, null, false)).toEqual({ x: 20, y: 20, w: 90, h: 50 });
    expect(resizeCropRect(box, 'e', 10, 0, null, true)).toEqual({ x: 0, y: 20, w: 120, h: 50 });
    // Keeping 1 : 2 (h / w = 0.5) from a corner and from an edge.
    expect(resizeCropRect(box, 'nw', -20, 0, 0.5, false)).toEqual({ x: -10, y: 10, w: 120, h: 60 });
    expect(resizeCropRect(box, 's', 0, 10, 0.5, false)).toEqual({ x: 0, y: 20, w: 120, h: 60 });
  });

  it('fits a ratio inside a rectangle', () => {
    expect(fitRatio({ x: 0, y: 0, w: 400, h: 300 }, 1)).toEqual({ x: 50, y: 0, w: 300, h: 300 });
    expect(fitRatio({ x: 0, y: 0, w: 400, h: 300 }, 9 / 16)).toEqual({ x: 0, y: 38, w: 400, h: 225 });
  });
});

describe('Crop tool', () => {
  it('starts with a box over the whole canvas; dragging draws a new one; Enter crops', () => {
    const { ctx, tool, last, executed } = setup();
    expect(last()).toEqual({ rect: null, thirds: false });
    drag(tool, ctx, [50, 40], [250, 140]);
    expect(tool.box).toEqual({ x: 50, y: 40, w: 200, h: 100 });
    expect(last()).toEqual({ rect: tool.box, thirds: false });
    expect(tool.onKeyDown('Enter', ctx)).toBe(true);
    expect(executed).toEqual([{ name: 'crop', params: { x: 50, y: 40, w: 200, h: 100, deleteCropped: true } }]);
    expect(tool.box).toBeNull();
  });

  it('moves the box from inside, resizes it from its handles, and shows thirds while dragging', () => {
    const { ctx, tool, shown } = setup();
    drag(tool, ctx, [50, 40], [250, 140]);
    tool.onPointerDown(ev(100, 80), ctx);
    tool.onPointerMove(ev(110, 85), ctx);
    expect(shown.at(-1)).toEqual({ rect: { x: 60, y: 45, w: 200, h: 100 }, thirds: true });
    tool.onPointerUp(ev(110, 85), ctx);
    drag(tool, ctx, [260, 145], [280, 155]); // the bottom-right corner
    expect(tool.box).toEqual({ x: 60, y: 45, w: 220, h: 110 });
    drag(tool, ctx, [280, 155], [300, 155], { shiftKey: true }); // Shift keeps 2 : 1
    expect(tool.box).toEqual({ x: 60, y: 45, w: 240, h: 120 });
  });

  it('a click without dragging keeps the box; Escape resets it, then passes Escape on', () => {
    const { ctx, tool, executed } = setup();
    drag(tool, ctx, [50, 40], [250, 140]);
    tool.onPointerDown(ev(300, 200), ctx);
    tool.onPointerUp(ev(301, 200), ctx);
    expect(tool.box).toEqual({ x: 50, y: 40, w: 200, h: 100 });
    expect(tool.onKeyDown('Escape', ctx)).toBe(true);
    expect(tool.box).toBeNull();
    expect(tool.onKeyDown('Escape', ctx)).toBe(false);
    tool.onKeyDown('Enter', ctx); // the untouched box: nothing to crop
    expect(executed).toEqual([]);
  });

  it('a ratio reshapes the box and constrains drawing; Delete Cropped Pixels is passed on', () => {
    const { ctx, tool, executed } = setup();
    tool.setOptions({ ratioW: 1, ratioH: 1 }, ctx);
    expect(tool.box).toEqual({ x: 50, y: 0, w: 300, h: 300 });
    drag(tool, ctx, [10, 10], [50, 20]);
    expect(tool.box).toEqual({ x: 10, y: 10, w: 40, h: 40 });
    tool.setOptions({ deleteCropped: false });
    tool.commit(ctx);
    expect(executed[0]!.params).toMatchObject({ deleteCropped: false });
  });

  it('switching tools hides the box', () => {
    const { ctx, tool, last } = setup();
    drag(tool, ctx, [50, 40], [250, 140]);
    tool.deactivate(ctx);
    expect(last()).toBeNull();
    expect(tool.box).toBeNull();
  });
});
