import type { ComponentType } from 'react';
import type { IconName } from '../icons';
import { HistoryPanel } from './HistoryPanel';
import { LayersPanel } from './layers/LayersPanel';
import { BrushSettingsPanel } from './BrushSettingsPanel';
import { BrushesPanel } from './BrushesPanel';
import { ToolPresetsPanel } from './ToolPresetsPanel';
import { ColorPanel } from './ColorPanel';
import { SwatchesPanel } from './SwatchesPanel';
import { GradientsPanel } from './GradientsPanel';
import { PatternsPanel } from './PatternsPanel';
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
  color: { id: 'color', title: 'Color', icon: 'colorPanel', component: ColorPanel, float: { width: 290, height: 300 } },
  swatches: {
    id: 'swatches',
    title: 'Swatches',
    icon: 'swatches',
    component: SwatchesPanel,
    float: { width: 290, height: 360 },
    menu: [
      { label: 'New Swatch…', command: 'swatches.new' },
      { label: 'New Swatch Group…', command: 'swatches.newGroup' },
      { label: 'Rename Swatch…', command: 'swatches.rename' },
      { label: 'Delete Swatch', command: 'swatches.delete' },
      { label: 'Import Swatches…', command: 'swatches.import' },
      { label: 'Restore Default Swatches…', command: 'swatches.restore' },
    ],
  },
  gradients: {
    id: 'gradients',
    title: 'Gradients',
    icon: 'gradient',
    component: GradientsPanel,
    float: { width: 290, height: 360 },
    menu: [
      { label: 'New Gradient…', command: 'gradients.new' },
      { label: 'New Gradient Group…', command: 'gradients.newGroup' },
      { label: 'Rename Gradient…', command: 'gradients.rename' },
      { label: 'Delete Gradient', command: 'gradients.delete' },
      { label: 'Import Gradients…', command: 'gradients.import' },
      { label: 'Export Selected Gradients…', command: 'gradients.export' },
      { label: 'Restore Default Gradients…', command: 'gradients.restore' },
    ],
  },
  patterns: {
    id: 'patterns',
    title: 'Patterns',
    icon: 'pattern',
    component: PatternsPanel,
    float: { width: 290, height: 360 },
    menu: [
      { label: 'New Pattern…', command: 'edit.definePattern' },
      { label: 'New Pattern Group…', command: 'patterns.newGroup' },
      { label: 'Rename Pattern…', command: 'patterns.rename' },
      { label: 'Delete Pattern', command: 'patterns.delete' },
      { label: 'Import Patterns…', command: 'patterns.import' },
      { label: 'Export Selected Patterns…', command: 'patterns.export' },
      { label: 'Restore Default Patterns…', command: 'patterns.restore' },
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
