import { describe, expect, it } from 'vitest';
import type { CommandDescriptor } from '../../../src/core/commands/command';
import { ImageDocument } from '../../../src/core/document/document';
import { Selection } from '../../../src/core/selection/selection';
import { Viewport } from '../../../src/engine/viewport/viewport';
import { DEFAULT_PAINT_BUCKET_OPTIONS, PaintBucketTool } from '../../../src/tools/paint-bucket/paint-bucket-tool';
import { BUCKET_CURSOR, EYEDROPPER_CURSOR } from '../../../src/tools/paint/cursors';
import { createTools } from '../../../src/tools/registry';
import { DEFAULT_CURSOR_PREFERENCES, type ToolContext, type ToolPointerEvent } from '../../../src/tools/types';

/** A 40 × 30 document shown at 200 %, document (0, 0) at view (0, 0), with a white Background. */
function setup(init: { mode?: 'rgb' | 'grayscale'; depth?: 8 | 16 } = {}) {
  const doc = new ImageDocument({ width: 40, height: 30, ...init });
  const bg = doc.createBackgroundLayer();
  doc.insertLayer(bg);
  doc.setActiveLayer(bg.id);
  const viewport = new Viewport({ viewWidth: 80, viewHeight: 60, zoom: 2, centerX: 20, centerY: 15 });
  const executed: CommandDescriptor[] = [];
  const reports: string[] = [];
  let foreground = { r: 1, g: 0.5, b: 0 };
  const ctx: ToolContext = {
    viewport,
    document: doc,
    devicePixelRatio: 1,
    viewChanged: () => {},
    setOverlayRect: () => {},
    setSelectionPreview: () => {},
    execute: (d) => executed.push(d),
    paint: null,
    setBrushOutline: () => {},
    setCropBox: () => {},
    setTransformBox: () => {},
    preview: () => {},
    selectLayers: () => {},
    report: (_title, message) => reports.push(message),
    cursorPreferences: DEFAULT_CURSOR_PREFERENCES,
    setBrushHud: () => {},
    toolOptionsChanged: () => {},
    showSymmetry: () => {},
    setSymmetryEdit: () => {},
    colors: {
      sample: () => Promise.resolve({ r: 0, g: 0, b: 1 }),
      get: (which) => (which === 'foreground' ? foreground : { r: 1, g: 1, b: 1 }),
      set: (which, c) => {
        if (which === 'foreground') foreground = c;
      },
      eyedropper: { sampleSize: 1, source: 'all', showRing: false },
    },
    setSampleRing: () => {},
    setGradientLine: () => {},
  };
  return { doc, ctx, tool: new PaintBucketTool(), executed, reports, foreground: () => foreground };
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

function click(tool: PaintBucketTool, ctx: ToolContext, x: number, y: number, mods: Partial<ToolPointerEvent> = {}) {
  tool.onPointerDown(ev(x, y, mods), ctx);
  tool.onPointerUp(ev(x, y, mods), ctx);
}

describe('the Paint Bucket tool', () => {
  it('shares G with the Gradient tool and starts with tolerance 32, anti-alias and contiguous on', () => {
    const tools = createTools();
    const group = tools.groups.find((g) => g.tools.includes(tools.paintBucket))!;
    expect(group.tools.map((t) => t.id)).toEqual(['gradient', 'paint-bucket']);
    expect(tools.paintBucket.key).toBe('G');
    expect(DEFAULT_PAINT_BUCKET_OPTIONS).toMatchObject({
      source: 'foreground',
      tolerance: 32,
      antiAlias: true,
      contiguous: true,
      allLayers: false,
      mode: 'normal',
      opacity: 1,
    });
  });

  it('a click fills at the document pixel under it with the foreground colour and the options', () => {
    const { ctx, tool, executed } = setup();
    tool.setOptions({ tolerance: 10, mode: 'multiply', opacity: 0.5, allLayers: true, contiguous: false });
    click(tool, ctx, 21, 9); // view (21, 9) at 200 % = document (10.5, 4.5)
    expect(executed).toEqual([
      {
        name: 'paintBucket',
        params: {
          point: { x: 10, y: 4 },
          tolerance: 10,
          contiguous: false,
          antiAlias: true,
          allLayers: true,
          color: [255, 128, 0],
          mode: 'multiply',
          opacity: 0.5,
        },
      },
    ]);
  });

  it('fills with the chosen pattern; colours become document values (Grayscale, 16-bit)', () => {
    const a = setup();
    a.tool.setOptions({ source: 'pattern', patternId: 'pf-dots' });
    click(a.tool, a.ctx, 2, 2);
    expect(a.executed[0]!.params['pattern']).toBe('pf-dots');
    expect(a.executed[0]!.params['color']).toBeUndefined();
    const b = setup({ mode: 'grayscale', depth: 16 });
    click(b.tool, b.ctx, 2, 2);
    expect(b.executed[0]!.params['color']).toEqual([Math.round((0.299 + 0.587 * 0.5) * 65535)]);
  });

  it('does nothing off the canvas or outside the selection, and explains a locked or missing pixel layer', () => {
    const { doc, ctx, tool, executed, reports } = setup();
    click(tool, ctx, -4, 2);
    click(tool, ctx, 2, 70);
    const data = new Uint8Array(256 * 256);
    data.fill(255, 0, 10); // the first 10 pixels of row 0
    doc.setSelection(new Selection({ tiles: [{ tx: 0, ty: 0, data }], fill: 0, offsetX: 0, offsetY: 0 }));
    click(tool, ctx, 30, 30);
    expect(executed).toEqual([]);
    click(tool, ctx, 2, 0);
    expect(executed).toHaveLength(1);

    doc.background!.locks = { ...doc.background!.locks, pixels: true };
    click(tool, ctx, 2, 0);
    expect(executed).toHaveLength(1);
    expect(reports.at(-1)).toMatch(/locked/);
  });

  it('Alt-click picks up the foreground colour instead of filling', async () => {
    const { ctx, tool, executed, foreground } = setup();
    expect(tool.cursor({ altKey: true, dragging: false })).toBe(EYEDROPPER_CURSOR);
    expect(tool.cursor({ altKey: false, dragging: false })).toBe(BUCKET_CURSOR);
    tool.onPointerDown(ev(4, 4, { altKey: true }), ctx);
    tool.onPointerUp(ev(4, 4, { altKey: true }), ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(foreground()).toEqual({ r: 0, g: 0, b: 1 });
    expect(executed).toEqual([]);
  });

  it('keeps its options in tool presets', () => {
    const a = new PaintBucketTool();
    a.setOptions({ source: 'pattern', patternId: 'pf-canvas', tolerance: 90, contiguous: false, mode: 'screen' });
    const b = new PaintBucketTool();
    b.applyPresetOptions(a.presetOptions());
    expect(b.options).toEqual(a.options);
    b.applyPresetOptions({ tolerance: 999, opacity: -1 });
    expect(b.options.tolerance).toBe(255);
    expect(b.options.opacity).toBe(0.01);
  });
});
