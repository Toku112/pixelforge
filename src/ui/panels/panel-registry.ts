import type { ComponentType } from 'react';
import type { IconName } from '../icons';
import { HistoryPanel } from './HistoryPanel';
import { LayersPanel } from './layers/LayersPanel';
import { BrushSettingsPanel } from './BrushSettingsPanel';
import { NavigatorPanel } from './NavigatorPanel';

export interface PanelDefinition {
  id: string;
  title: string;
  icon: IconName;
  component: ComponentType;
  /** Extra panel-menu entries (app command ids). */
  menu?: { label: string; command: string }[];
  /** Opens as a floating window of this size (CSS pixels) when it isn't in the workspace. */
  float?: { width: number; height: number };
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
  'brush-settings': {
    id: 'brush-settings',
    title: 'Brush Settings',
    icon: 'brush',
    component: BrushSettingsPanel,
    float: { width: 430, height: 500 },
    menu: [{ label: 'Clear Brush Controls', command: 'brush.clearControls' }],
  },
  layers: {
    id: 'layers',
    title: 'Layers',
    icon: 'layers',
    component: LayersPanel,
    menu: [
      { label: 'New Layer…', command: 'layer.new' },
      { label: 'Duplicate Layer…', command: 'layer.duplicate' },
      { label: 'Delete Layer', command: 'layer.delete' },
      { label: 'Delete Hidden Layers', command: 'layer.deleteHidden' },
      { label: 'New Group…', command: 'layer.newGroup' },
      { label: 'New Group from Layers…', command: 'layer.groupFromLayers' },
      { label: 'Collapse All Groups', command: 'layers.collapseAll' },
      { label: 'Layer from Background…', command: 'layer.fromBackground' },
      { label: 'Rename Layer…', command: 'layer.rename' },
      { label: 'Merge Down', command: 'layer.mergeDown' },
      { label: 'Merge Visible', command: 'layer.mergeVisible' },
      { label: 'Flatten Image', command: 'layer.flatten' },
    ],
  },
};
