import { describe, expect, it } from 'vitest';
import type { PaintTool } from '../../../src/core/commands/builtin/paint';
import { ImageDocument } from '../../../src/core/document/document';
import { DEFAULT_RETOUCH } from '../../../src/core/paint/retouch';
import { DEFAULT_DODGE, DEFAULT_SPONGE } from '../../../src/core/paint/tone';
import { Viewport } from '../../../src/engine/viewport/viewport';
import { createTools } from '../../../src/tools/registry';
import {
  DEFAULT_CURSOR_PREFERENCES,
  type PaintBeginOptions,
  type PaintStroke,
  type ToolContext,
  type ToolPointerEvent,
} from '../../../src/tools/types';

/** A document and a paint host that records what each stroke began as. */
function setup() {
  const doc = new ImageDocument({ width: 40, height: 30 });
  const bg = doc.createBackgroundLayer();
  doc.insertLayer(bg);
  doc.setActiveLayer(bg.id);
  const begun: { tool: PaintTool; options?: PaintBeginOptions; opacity: number }[] = [];
  const stroke: PaintStroke = {
    seed: 1,
    colors: null,
    symmetry: null,
    add: () => {},
    end: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
  };
  const ctx = {
    viewport: new Viewport({ viewWidth: 40, viewHeight: 30, zoom: 1, centerX: 20, centerY: 15 }),
    document: doc,
    devicePixelRatio: 1,
    paint: {
      begin: (tool: PaintTool, brush: { opacity: number }, options?: PaintBeginOptions) => {
        begun.push({ tool, opacity: brush.opacity, ...(options ? { options } : {}) });
        return stroke;
      },
    },
    setBrushOutline: () => {},
    cursorPreferences: DEFAULT_CURSOR_PREFERENCES,
    showSymmetry: () => {},
  } as unknown as ToolContext;
  return { tools: createTools(), ctx, begun };
}

const ev = (altKey = false): ToolPointerEvent => ({
  x: 10,
  y: 10,
  shiftKey: false,
  altKey,
  primaryKey: false,
  spaceKey: false,
  pressure: 1,
});

function click(
  tool: {
    onPointerDown(e: ToolPointerEvent, c: ToolContext): void;
    onPointerUp(e: ToolPointerEvent, c: ToolContext): void;
  },
  ctx: ToolContext,
  alt = false,
) {
  tool.onPointerDown(ev(alt), ctx);
  tool.onPointerUp(ev(alt), ctx);
}

describe('retouching tools', () => {
  it('Blur, Sharpen, Smudge share a group without a letter; Dodge, Burn, Sponge share O', () => {
    const { tools } = setup();
    const group = (id: string) => tools.groups.find((g) => g.tools.some((t) => t.id === id))!;
    expect(group('blur').tools.map((t) => t.id)).toEqual(['blur', 'sharpen', 'smudge']);
    expect(group('dodge').tools.map((t) => t.id)).toEqual(['dodge', 'burn', 'sponge']);
    expect(tools.blur.key).toBe('');
    expect(tools.sponge.key).toBe('O');
    expect(tools.blur.retouch).toEqual(DEFAULT_RETOUCH);
    expect(tools.dodge.tone).toEqual(DEFAULT_DODGE);
    expect(tools.sponge.sponge).toEqual(DEFAULT_SPONGE);
    expect(tools.sponge.options.flow).toBe(0.5);
    expect(tools.blur.usesSymmetry).toBe(false);
  });

  it('Alt switches Blur and Sharpen, and Dodge and Burn, for a stroke', () => {
    const { tools, ctx, begun } = setup();
    click(tools.blur, ctx);
    click(tools.blur, ctx, true);
    click(tools.sharpen, ctx, true);
    click(tools.dodge, ctx, true);
    expect(begun.map((b) => b.tool)).toEqual(['blur', 'sharpen', 'blur', 'burn']);
    expect(begun[1]!.options?.retouch).toMatchObject({ protectDetail: true });
    expect(begun[3]!.options?.tone).toMatchObject({ kind: 'burn', range: 'midtones' });
    expect(begun[3]!.opacity).toBe(DEFAULT_DODGE.exposure); // Exposure is the stroke's opacity
  });

  it('Alt switches Finger Painting for one Smudge stroke', () => {
    const { tools, ctx, begun } = setup();
    click(tools.smudge, ctx);
    click(tools.smudge, ctx, true);
    tools.smudge.setRetouch({ fingerPainting: true });
    click(tools.smudge, ctx, true);
    expect(begun.map((b) => b.options?.retouch?.finger)).toEqual([false, true, false]);
  });
});
