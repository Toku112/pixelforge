/**
 * The tools available in this build, grouped as on the toolbar. Tools that are not
 * implemented yet are not listed (no placeholder tools).
 */
import { CropTool } from './crop/crop-tool';
import { HandTool } from './hand/hand-tool';
import { MoveTool } from './move/move-tool';
import { PaintingTool } from './paint/paint-tool';
import { RotateViewTool } from './rotate-view/rotate-view-tool';
import { TransformTool } from './transform/transform-tool';
import { SymmetryTool } from './symmetry/symmetry-tool';
import { EyedropperTool } from './eyedropper/eyedropper-tool';
import { LassoTool, PolygonalLassoTool } from './selection/lasso-tool';
import { MarqueeTool, SingleLineMarqueeTool } from './selection/marquee-tool';
import type { Tool } from './types';
import { ZoomTool } from './zoom/zoom-tool';

export interface ToolGroup {
  id: string;
  tools: Tool[];
  /** Tools that Shift + the group's letter cycles through (default: all). */
  cycle?: string[];
}

export function createTools() {
  const move = new MoveTool();
  const hand = new HandTool();
  const rotateView = new RotateViewTool();
  const zoom = new ZoomTool();
  const marqueeRect = new MarqueeTool('rect');
  const marqueeEllipse = new MarqueeTool('ellipse');
  const marqueeRow = new SingleLineMarqueeTool('row');
  const marqueeColumn = new SingleLineMarqueeTool('column');
  const lasso = new LassoTool();
  const polygonalLasso = new PolygonalLassoTool();
  const crop = new CropTool();
  const eyedropper = new EyedropperTool();
  // Not on the toolbar: the app switches to it while Free Transform is open.
  const transform = new TransformTool();
  // Not on the toolbar either: placing a paint symmetry's guide.
  const symmetry = new SymmetryTool();
  const brush = new PaintingTool('brush');
  const pencil = new PaintingTool('pencil');
  const eraser = new PaintingTool('eraser');
  const groups: ToolGroup[] = [
    { id: 'move-group', tools: [move] },
    {
      id: 'marquee-group',
      tools: [marqueeRect, marqueeEllipse, marqueeRow, marqueeColumn],
      cycle: [marqueeRect.id, marqueeEllipse.id],
    },
    { id: 'lasso-group', tools: [lasso, polygonalLasso] },
    { id: 'crop-group', tools: [crop] },
    { id: 'eyedropper-group', tools: [eyedropper] },
    { id: 'brush-group', tools: [brush, pencil] },
    { id: 'eraser-group', tools: [eraser] },
    { id: 'hand-group', tools: [hand, rotateView] },
    { id: 'zoom-group', tools: [zoom] },
  ];
  const byId = new Map<string, Tool>(groups.flatMap((g) => g.tools.map((t) => [t.id, t] as const)));
  byId.set(transform.id, transform);
  byId.set(symmetry.id, symmetry);
  return {
    move,
    hand,
    rotateView,
    zoom,
    marqueeRect,
    marqueeEllipse,
    marqueeRow,
    marqueeColumn,
    lasso,
    polygonalLasso,
    crop,
    eyedropper,
    transform,
    symmetry,
    brush,
    pencil,
    eraser,
    groups,
    byId,
  };
}

export type ToolSet = ReturnType<typeof createTools>;
