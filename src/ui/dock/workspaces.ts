/**
 * Built-in panel layouts (Window > Workspace). Only implemented panels appear.
 */
import type { DockLayout } from './dock-model';

export function essentialsLayout(): DockLayout {
  return {
    columns: [
      {
        id: 'main',
        width: 260,
        collapsed: false,
        groups: [
          { id: 'g-navigator', panels: ['navigator'], active: 'navigator', weight: 0.9 },
          { id: 'g-history', panels: ['history'], active: 'history', weight: 0.9 },
          { id: 'g-layers', panels: ['layers'], active: 'layers', weight: 2 },
        ],
      },
    ],
    floating: [],
  };
}
