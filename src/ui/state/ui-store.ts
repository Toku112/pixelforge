/**
 * UI state (Zustand): active tool, panel layout, dialogs and the current view
 * readout. Document data lives in the Workspace, not here.
 */
import type { PreferenceValues } from '../../app/preferences';
import { create } from 'zustand';
import type { RGB } from '../../core/color/color';
import type { Gradient, GradientMethod } from '../../core/paint/gradient';
import type { BlendMode, LayerBlendMode } from '../../core/document/layers';
import type { DocumentPreset, NewDocumentSettings } from '../../core/document/new-document';
import type { ResampleMethod } from '../../core/geometry/layer-geometry';
import type { JpegSaveOptions } from '../../io/jpeg-options';
import type { WebpSaveOptions } from '../../io/webp-options';
import type { ViewportState } from '../../engine/viewport/viewport';
import { sanitizeLayout, type DockLayout } from '../dock/dock-model';
import { essentialsLayout } from '../dock/workspaces';

export const PANEL_IDS = [
  'history',
  'navigator',
  'layers',
  'brush-settings',
  'brushes',
  'tool-presets',
  'color',
  'swatches',
  'gradients',
  'patterns',
] as const;
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

/** A name to ask for (with an optional checkbox). */
export interface NameRequest {
  title: string;
  name: string;
  option?: { label: string; checked: boolean };
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
  | ({ kind: 'fill'; resolve: (result: FillResult | null) => void } & FillRequest)
  | ({ kind: 'image-size'; resolve: (result: ImageSizeResult | null) => void } & SizeRequest)
  | ({ kind: 'canvas-size'; resolve: (result: CanvasSizeResult | null) => void } & CanvasSizeRequest)
  | ({ kind: 'new-document'; resolve: (result: NewDocumentResult | null) => void } & NewDocumentRequest)
  | ({ kind: 'save-as'; resolve: (result: SaveAsResult | null) => void } & SaveAsRequest)
  | ({ kind: 'jpeg-options'; resolve: (result: JpegSaveOptions | null) => void } & JpegOptionsRequest)
  | ({ kind: 'webp-options'; resolve: (result: WebpSaveOptions | null) => void } & WebpOptionsRequest)
  | {
      kind: 'brush-name';
      /** The new tip (coverage 0–255). */
      tip: { width: number; height: number; data: Uint8Array };
      name: string;
      resolve: (name: string | null) => void;
    }
  | { kind: 'preferences'; values: PreferenceValues; resolve: (values: PreferenceValues | null) => void }
  | ({ kind: 'name'; resolve: (answer: { name: string; option: boolean } | null) => void } & NameRequest)
  | {
      kind: 'gradient-editor';
      gradient: Gradient;
      method: GradientMethod;
      resolve: (gradient: Gradient | null) => void;
    }
  | {
      kind: 'export-groups';
      title: string;
      /** Label for the '' group (presets outside any group). */
      ungroupedLabel: string;
      groups: string[];
      selected: string[];
      resolve: (groups: string[] | null) => void;
    }
  | {
      kind: 'symmetry-segments';
      symmetry: 'radial' | 'mandala';
      segments: number;
      resolve: (segments: number | null) => void;
    };

export interface WebpOptionsRequest {
  options: WebpSaveOptions;
  /** The browser can encode lossy WebP. */
  lossySupported: boolean;
  /** The file size these options would give, in bytes. */
  estimate: (options: WebpSaveOptions) => Promise<number>;
}

export interface JpegOptionsRequest {
  options: JpegSaveOptions;
  /** Offer the matte colour (the image has transparent areas). */
  hasTransparency: boolean;
  foreground: RGB;
  background: RGB;
  /** The file size these options would give, in bytes. */
  estimate: (options: JpegSaveOptions) => Promise<number>;
}

export interface SaveAsRequest {
  /** Suggested file name, without extension. */
  name: string;
  formats: { id: string; label: string; restriction: string | null; keepsLayers: boolean }[];
  format: string;
  /** The image has more than one layer (flat formats save a flattened copy). */
  layered: boolean;
}

export interface SaveAsResult {
  name: string;
  format: string;
}

/** The document's current size, for Image Size and Canvas Size. */
export interface SizeRequest {
  width: number;
  height: number;
  /** Pixels per inch. */
  resolution: number;
  /** Bytes per pixel of the flattened image (for the memory readout). */
  bytesPerPixel: number;
}

export interface ImageSizeResult {
  width: number;
  height: number;
  resolution: number;
  method: ResampleMethod;
}

export interface CanvasSizeRequest extends SizeRequest {
  /** The canvas extension colour applies (the document has a Background). */
  hasBackground: boolean;
  foreground: RGB;
  background: RGB;
}

export interface CanvasSizeResult {
  width: number;
  height: number;
  /** Where the image stays: 0 = left/top, 0.5 = centre, 1 = right/bottom. */
  anchor: [number, number];
  color: RGB;
}

/** File > New: the starting values and the preset lists. */
export interface NewDocumentRequest {
  /** The suggested document name ("Untitled-1"). */
  name: string;
  settings: NewDocumentSettings;
  recent: readonly DocumentPreset[];
  saved: readonly DocumentPreset[];
  /** The background colour (Background Contents: Background Color). */
  background: RGB;
  /** Saves a preset; the saved presets afterwards. */
  savePreset: (preset: DocumentPreset) => Promise<readonly DocumentPreset[]>;
  /** Deletes a saved preset; the saved presets afterwards. */
  deletePreset: (id: string) => Promise<readonly DocumentPreset[]>;
}

export interface NewDocumentResult {
  name: string;
  /** The preset the settings came from, or "Custom" when they were changed. */
  presetName: string;
  settings: NewDocumentSettings;
}

export type FillContents = 'foreground' | 'background' | 'color' | 'pattern' | 'history' | 'black' | 'gray' | 'white';

export interface FillRequest {
  contents: FillContents;
  foreground: RGB;
  background: RGB;
  blendModes: readonly LayerBlendMode[];
  /** Preserve Transparency is offered (not on the Background). */
  canPreserve: boolean;
  preserve: boolean;
  /** The pattern offered for Pattern contents (an id). */
  pattern: string;
}

export interface FillResult {
  /** Pattern contents: the pattern's id (the colour is then unused). */
  pattern?: string;
  /** History contents: the History Brush source (the colour is then unused). */
  history?: boolean;
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
