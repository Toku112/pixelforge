/** Toolbar and options-bar icon for each tool. */
import type { IconName } from './icons';

export const TOOL_ICONS: Readonly<Record<string, IconName>> = {
  move: 'move',
  hand: 'hand',
  'rotate-view': 'rotateView',
  zoom: 'zoom',
  'marquee-rect': 'marqueeRect',
  'marquee-ellipse': 'marqueeEllipse',
  'marquee-row': 'marqueeRow',
  'marquee-column': 'marqueeColumn',
  lasso: 'lasso',
  'polygonal-lasso': 'polygonalLasso',
  crop: 'crop',
  transform: 'transform',
  brush: 'brush',
  eraser: 'eraser',
};

export function toolIcon(toolId: string): IconName {
  return TOOL_ICONS[toolId] ?? 'hand';
}
