/** The application window: menu bar, options bar, toolbar, documents, panels, status bar. */
import { Docks } from './dock/Dock';
import { CanvasArea } from './canvas/CanvasArea';
import { MenuBar } from './menus/MenuBar';
import { Dialogs } from './shell/Dialogs';
import { DocumentTabs } from './shell/DocumentTabs';
import { OptionsBar } from './shell/OptionsBar';
import { StatusBar } from './shell/StatusBar';
import { Toolbar } from './shell/Toolbar';

export function App() {
  return (
    <div className="app-root" data-testid="app-root">
      <MenuBar />
      <OptionsBar />
      <div className="workarea">
        <Toolbar />
        <main className="document-area">
          <DocumentTabs />
          <CanvasArea />
          <StatusBar />
        </main>
        <Docks />
      </div>
      <Dialogs />
    </div>
  );
}
