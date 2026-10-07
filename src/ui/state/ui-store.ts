/**
 * UI state (Zustand): active tool, panel layout, dialogs and the current view
 * readout. Document data lives in the Workspace, not here.
 */
import { create } from 'zustand';
import type { RGB } from '../../core/color/color';
import type { BlendMode, LayerBlendMode } from '../../core/document/layers';
import type { ViewportState } from '../../engine/viewport/viewport';
import { sanitizeLayout, type DockLayout } from '../dock/dock-model';
import { essentialsLayout } from '../dock/workspaces';

export const PANEL_IDS = ['history', 'navigator', 'layers'] as const;
export type PanelKey = (typeof PANEL_IDS)[number];

/** Name, blend mode and opacity from the New Layer / New Group dialogs. */
export interface LayerOptionsResult {
  name: string;
  blendMode: BlendMode;
  opacity: number;
}

export interface LayerOptionsRequest {
  title: string;
  name: string;
  blendModes: readonly BlendMode[];
  blendMode: BlendMode;
  opacity: number;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  /** Offers "Don't show again"; the answer is remembered under this key. */
  rememberKey?: string;
}

export type DialogRequest =
  | { kind: 'alert'; title: string; message: string; resolve: () => void }
  | { kind: 'confirm-save'; documentName: string; resolve: (answer: 'save' | 'discard' | 'cancel') => void }
  | { kind: 'about'; resolve: () => void }
  | ({ kind: 'layer-options'; resolve: (result: LayerOptionsResult | null) => void } & LayerOptionsRequest)
  | {
      kind: 'duplicate-layer';
      /** Name of the layer being duplicated, or null for several layers. */
      source: string | null;
      name: string;
      resolve: (result: { name?: string } | null) => void;
    }
  | ({ kind: 'confirm'; resolve: (ok: boolean) => void } & ConfirmRequest)
  | { kind: 'color-picker'; title: string; color: RGB; resolve: (color: RGB | null) => void }
  | ({ kind: 'fill'; resolve: (result: FillResult | null) => void } & FillRequest);

export type FillContents = 'foreground' | 'background' | 'color' | 'black' | 'gray' | 'white';

export interface FillRequest {
  contents: FillContents;
  foreground: RGB;
  background: RGB;
  blendModes: readonly LayerBlendMode[];
  /** Preserve Transparency is offered (not on the Background). */
  canPreserve: boolean;
  preserve: boolean;
}

export interface FillResult {
  color: RGB;
  mode: LayerBlendMode;
  opacity: number;
  preserveTransparency: boolean;
}

export type StatusInfo = 'sizes' | 'dimensions' | 'profile' | 'scratch' | 'tool';

// Versioned: a new default layout (Essentials gained the Layers panel) replaces older saved ones.
const LAYOUT_KEY = 'pixelforge.dockLayout.v2';
const REMEMBER_PREFIX = 'pixelforge.dontShowAgain.';

/** Whether the user ticked "Don't show again" for a confirmation (kept per browser, like the panel layout). */
export function isRemembered(key: string): boolean {
  try {
    return window.localStorage.getItem(REMEMBER_PREFIX + key) === '1';
  } catch {
    return false;
  }
}

export function remember(key: string): void {
  try {
    window.localStorage.setItem(REMEMBER_PREFIX + key, '1');
  } catch {
    // Not persisted; the dialog will show again next time.
  }
}

function loadLayout(): DockLayout {
  try {
    const stored = window.localStorage.getItem(LAYOUT_KEY);
    const layout = stored ? sanitizeLayout(JSON.parse(stored), new Set(PANEL_IDS)) : null;
    return layout ?? essentialsLayout();
  } catch {
    return essentialsLayout();
  }
}

function saveLayout(layout: DockLayout): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Not persisted (e.g. storage disabled); the layout still works for this session.
  }
}

interface UiState {
  activeToolId: string;
  /** Last tool used in each toolbar group (shown on the group's button). */
  groupTool: Record<string, string>;
  /** Bumped when tool options change outside React (options bar re-reads them). */
  toolOptionsVersion: number;
  dock: DockLayout;
  dialogs: DialogRequest[];
  view: ViewportState | null;
  statusInfo: StatusInfo;
  dropActive: boolean;
  /** Layer whose name is being edited in the Layers panel. */
  renamingLayerId: string | null;
  setActiveTool: (id: string, groupId?: string) => void;
  bumpToolOptions: () => void;
  setDock: (layout: DockLayout) => void;
  pushDialog: (dialog: DialogRequest) => void;
  closeDialog: (dialog: DialogRequest) => void;
  setView: (view: ViewportState | null) => void;
  setStatusInfo: (info: StatusInfo) => void;
  setDropActive: (active: boolean) => void;
  setRenamingLayer: (id: string | null) => void;
}

export const useUi = create<UiState>()((set) => ({
  activeToolId: 'hand',
  groupTool: {},
  toolOptionsVersion: 0,
  dock: loadLayout(),
  dialogs: [],
  view: null,
  statusInfo: 'sizes',
  dropActive: false,
  renamingLayerId: null,
  setActiveTool: (id, groupId) =>
    set((s) => ({ activeToolId: id, groupTool: groupId ? { ...s.groupTool, [groupId]: id } : s.groupTool })),
  bumpToolOptions: () => set((s) => ({ toolOptionsVersion: s.toolOptionsVersion + 1 })),
  setDock: (dock) => {
    saveLayout(dock);
    set({ dock });
  },
  pushDialog: (dialog) => set((s) => ({ dialogs: [...s.dialogs, dialog] })),
  closeDialog: (dialog) => set((s) => ({ dialogs: s.dialogs.filter((d) => d !== dialog) })),
  setView: (view) => set({ view }),
  setStatusInfo: (statusInfo) => set({ statusInfo }),
  setDropActive: (dropActive) => set({ dropActive }),
  setRenamingLayer: (renamingLayerId) => set({ renamingLayerId }),
}));

export function resetDock(): void {
  useUi.getState().setDock(essentialsLayout());
}
