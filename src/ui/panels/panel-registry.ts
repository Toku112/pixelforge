import type { ComponentType } from 'react';
import type { IconName } from '../icons';
import { HistoryPanel } from './HistoryPanel';
import { LayersPanel } from './layers/LayersPanel';
import { BrushSettingsPanel } from './BrushSettingsPanel';
import { BrushesPanel } from './BrushesPanel';
import { ToolPresetsPanel } from './ToolPresetsPanel';
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
  brushes: {
    id: 'brushes',
    title: 'Brushes',
    icon: 'brush',
    component: BrushesPanel,
    float: { width: 330, height: 520 },
    menu: [
      { label: 'New Brush Preset…', command: 'brushes.newPreset' },
      { label: 'New Brush Group…', command: 'brushes.newGroup' },
      { label: 'Rename Brush…', command: 'brushes.rename' },
      { label: 'Delete Brush', command: 'brushes.delete' },
      { label: 'Rename Group…', command: 'brushes.renameGroup' },
      { label: 'Delete Group…', command: 'brushes.deleteGroup' },
      { label: 'Import Brushes…', command: 'brushes.import' },
      { label: 'Export Brushes…', command: 'brushes.export' },
      { label: 'Restore Default Brushes…', command: 'brushes.restore' },
    ],
  },
  'tool-presets': {
    id: 'tool-presets',
    title: 'Tool Presets',
    icon: 'toolPresets',
    component: ToolPresetsPanel,
    float: { width: 280, height: 360 },
    menu: [
      { label: 'New Tool Preset…', command: 'toolPresets.new' },
      { label: 'Rename Tool Preset…', command: 'toolPresets.rename' },
      { label: 'Delete Tool Preset', command: 'toolPresets.delete' },
    ],
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
