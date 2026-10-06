/**
 * The tools available in this build, grouped as on the toolbar. Tools that are not
 * implemented yet are not listed (no placeholder tools).
 */
import { HandTool } from './hand/hand-tool';
import { RotateViewTool } from './rotate-view/rotate-view-tool';
import type { Tool } from './types';
import { ZoomTool } from './zoom/zoom-tool';

export interface ToolGroup {
  id: string;
  tools: Tool[];
}

export function createTools() {
  const hand = new HandTool();
  const rotateView = new RotateViewTool();
  const zoom = new ZoomTool();
  const groups: ToolGroup[] = [
    { id: 'hand-group', tools: [hand, rotateView] },
    { id: 'zoom-group', tools: [zoom] },
  ];
  const byId = new Map<string, Tool>(groups.flatMap((g) => g.tools.map((t) => [t.id, t] as const)));
  return { hand, rotateView, zoom, groups, byId };
}

export type ToolSet = ReturnType<typeof createTools>;
