import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App';
import { AppProvider } from '../ui/AppContext';
import { isPanelOpen, togglePanel } from '../ui/dock/dock-model';
import { resetDock, useUi } from '../ui/state/ui-store';
import { AppController, type UiBridge } from './controller';
import { createServices } from './services';
import '../ui/styles/global.css';
import '../ui/styles/shell.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');

const ui = useUi.getState;
const bridge: UiBridge = {
  activeToolId: () => ui().activeToolId,
  setActiveTool: (id, groupId) => ui().setActiveTool(id, groupId),
  isPanelOpen: (id) => isPanelOpen(ui().dock, id),
  togglePanel: (id) => ui().setDock(togglePanel(ui().dock, id)),
  resetWorkspace: () => resetDock(),
  alert: (title, message) => new Promise((resolve) => ui().pushDialog({ kind: 'alert', title, message, resolve })),
  confirmSave: (documentName) =>
    new Promise((resolve) => ui().pushDialog({ kind: 'confirm-save', documentName, resolve })),
  about: () => new Promise((resolve) => ui().pushDialog({ kind: 'about', resolve })),
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
