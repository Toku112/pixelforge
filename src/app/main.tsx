import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App';
import { AppProvider } from '../ui/AppContext';
import { isPanelOpen, openPanel, togglePanel, type FloatHome } from '../ui/dock/dock-model';
import { PANELS } from '../ui/panels/panel-registry';
import { isRemembered, resetDock, useUi } from '../ui/state/ui-store';
import { AppController, type UiBridge } from './controller';
import { createServices } from './services';
import '../ui/styles/global.css';
import '../ui/styles/shell.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');

const ui = useUi.getState;
/** Where a panel with its own floating size opens: just left of the docks, below the bars. */
const home = (id: string): FloatHome | undefined => {
  const size = PANELS[id]?.float;
  if (!size) return undefined;
  const dock = ui().dock;
  const docks = dock.columns.reduce((sum, c) => sum + (c.collapsed ? 40 : c.width), 0);
  // Each further floating window a little down and to the left, so none hides another.
  const step = 28 * (dock.floating.length % 8);
  return { x: Math.max(8, window.innerWidth - docks - size.width - 16 - step), y: 96 + step, ...size };
};
const bridge: UiBridge = {
  activeToolId: () => ui().activeToolId,
  setActiveTool: (id, groupId) => ui().setActiveTool(id, groupId),
  isPanelOpen: (id) => isPanelOpen(ui().dock, id),
  togglePanel: (id) => ui().setDock(togglePanel(ui().dock, id, home(id))),
  resetWorkspace: () => resetDock(),
  alert: (title, message) => new Promise((resolve) => ui().pushDialog({ kind: 'alert', title, message, resolve })),
  confirmSave: (documentName) =>
    new Promise((resolve) => ui().pushDialog({ kind: 'confirm-save', documentName, resolve })),
  about: () => new Promise((resolve) => ui().pushDialog({ kind: 'about', resolve })),
  openPanel: (id) => ui().setDock(openPanel(ui().dock, id, home(id))),
  layerOptions: (request) => new Promise((resolve) => ui().pushDialog({ kind: 'layer-options', ...request, resolve })),
  duplicateLayer: (source, name) =>
    new Promise((resolve) => ui().pushDialog({ kind: 'duplicate-layer', source, name, resolve })),
  confirm: (request) =>
    request.rememberKey && isRemembered(request.rememberKey)
      ? Promise.resolve(true)
      : new Promise((resolve) => ui().pushDialog({ kind: 'confirm', ...request, resolve })),
  startRename: (layerId) => ui().setRenamingLayer(layerId),
  groupTool: (groupId) => ui().groupTool[groupId],
  toolOptionsChanged: () => ui().bumpToolOptions(),
  fill: (request) => new Promise((resolve) => ui().pushDialog({ kind: 'fill', ...request, resolve })),
  imageSize: (request) => new Promise((resolve) => ui().pushDialog({ kind: 'image-size', ...request, resolve })),
  canvasSize: (request) => new Promise((resolve) => ui().pushDialog({ kind: 'canvas-size', ...request, resolve })),
  newDocument: (request) => new Promise((resolve) => ui().pushDialog({ kind: 'new-document', ...request, resolve })),
  saveAs: (request) => new Promise((resolve) => ui().pushDialog({ kind: 'save-as', ...request, resolve })),
  jpegOptions: (request) => new Promise((resolve) => ui().pushDialog({ kind: 'jpeg-options', ...request, resolve })),
  webpOptions: (request) => new Promise((resolve) => ui().pushDialog({ kind: 'webp-options', ...request, resolve })),
  brushName: (tip, name) => new Promise((resolve) => ui().pushDialog({ kind: 'brush-name', tip, name, resolve })),
  preferences: (values) => new Promise((resolve) => ui().pushDialog({ kind: 'preferences', values, resolve })),
  askName: (request) => new Promise((resolve) => ui().pushDialog({ kind: 'name', ...request, resolve })),
  editGradient: (request) =>
    new Promise((resolve) => ui().pushDialog({ kind: 'gradient-editor', ...request, resolve })),
  exportGroups: (request) => new Promise((resolve) => ui().pushDialog({ kind: 'export-groups', ...request, resolve })),
  symmetrySegments: (symmetry, segments) =>
    new Promise((resolve) => ui().pushDialog({ kind: 'symmetry-segments', symmetry, segments, resolve })),
  pickColor: (title, color) =>
    new Promise((resolve) => ui().pushDialog({ kind: 'color-picker', title, color, resolve })),
};

const controller = new AppController(await createServices(), bridge);
// Exposed for diagnostics and end-to-end tests.
(window as unknown as { __pixelforge?: AppController }).__pixelforge = controller;

// Warn before leaving with unsaved changes.
window.addEventListener('beforeunload', (e) => {
  if (controller.workspace.sessions.some((s) => controller.workspace.isDirty(s))) e.preventDefault();
});

createRoot(rootElement).render(
  <StrictMode>
    <AppProvider controller={controller}>
      <App />
    </AppProvider>
  </StrictMode>,
);
