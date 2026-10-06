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
          { id: 'g-navigator', panels: ['navigator'], active: 'navigator', weight: 1 },
          { id: 'g-history', panels: ['history'], active: 'history', weight: 1.4 },
        ],
      },
    ],
    floating: [],
  };
}
