/* eslint-disable react-refresh/only-export-components -- context module: provider plus its hooks */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { AppController } from '../app/controller';
import type { Workspace } from '../app/workspace';

const ControllerContext = createContext<AppController | null>(null);

export function AppProvider({ controller, children }: { controller: AppController; children: ReactNode }) {
  return <ControllerContext.Provider value={controller}>{children}</ControllerContext.Provider>;
}

export function useController(): AppController {
  const controller = useContext(ControllerContext);
  if (!controller) throw new Error('useController must be used inside <AppProvider>');
  return controller;
}

/**
 * Subscribes to workspace changes and returns `select(workspace)`. The selector
 * runs on every workspace change; keep it cheap and return primitives or stable values.
 */
export function useWorkspace<T>(select: (workspace: Workspace) => T): T {
  const { workspace } = useController();
  const version = useSyncExternalStore(
    (onChange) => workspace.changes.on(onChange),
    () => workspace.version,
  );
  void version; // re-render on every change
  return select(workspace);
}
