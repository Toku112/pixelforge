/**
 * UI state (Zustand): active tool, panel layout, dialogs and the current view
 * readout. Document data lives in the Workspace, not here.
 */
import { create } from 'zustand';
import type { ViewportState } from '../../engine/viewport/viewport';
import { sanitizeLayout, type DockLayout } from '../dock/dock-model';
import { essentialsLayout } from '../dock/workspaces';

export const PANEL_IDS = ['history', 'navigator'] as const;
export type PanelKey = (typeof PANEL_IDS)[number];

export type DialogRequest =
  | { kind: 'alert'; title: string; message: string; resolve: () => void }
  | { kind: 'confirm-save'; documentName: string; resolve: (answer: 'save' | 'discard' | 'cancel') => void }
  | { kind: 'about'; resolve: () => void };

export type StatusInfo = 'sizes' | 'dimensions' | 'profile' | 'scratch' | 'tool';

const LAYOUT_KEY = 'pixelforge.dockLayout';

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
  setActiveTool: (id: string, groupId?: string) => void;
  bumpToolOptions: () => void;
  setDock: (layout: DockLayout) => void;
  pushDialog: (dialog: DialogRequest) => void;
  closeDialog: (dialog: DialogRequest) => void;
  setView: (view: ViewportState | null) => void;
  setStatusInfo: (info: StatusInfo) => void;
  setDropActive: (active: boolean) => void;
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
}));

export function resetDock(): void {
  useUi.getState().setDock(essentialsLayout());
}
