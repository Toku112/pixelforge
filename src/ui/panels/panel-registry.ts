import type { ComponentType } from 'react';
import type { IconName } from '../icons';
import { HistoryPanel } from './HistoryPanel';
import { NavigatorPanel } from './NavigatorPanel';

export interface PanelDefinition {
  id: string;
  title: string;
  icon: IconName;
  component: ComponentType;
  /** Extra panel-menu entries (app command ids). */
  menu?: { label: string; command: string }[];
}

export const PANELS: Record<string, PanelDefinition> = {
  history: {
    id: 'history',
    title: 'History',
    icon: 'history',
    component: HistoryPanel,
    menu: [
      { label: 'Step Forward', command: 'edit.redo' },
      { label: 'Step Backward', command: 'edit.undo' },
    ],
  },
  navigator: { id: 'navigator', title: 'Navigator', icon: 'navigator', component: NavigatorPanel },
};
