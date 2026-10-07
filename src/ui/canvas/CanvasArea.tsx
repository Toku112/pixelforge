/**
 * The document area: mounts the WebGL canvas (rendered imperatively, never by
 * React), shows the active document, keeps each document's view when switching
 * tabs, and opens files dropped onto it.
 */
import { useEffect, useRef } from 'react';
import type { DocumentSession } from '../../app/workspace';
import { readFile } from '../../io/file-access';
import { installFileDrop } from '../../io/drop';
import { useController, useWorkspace } from '../AppContext';
import { Icon } from '../icons';
import { useUi } from '../state/ui-store';
import { CanvasView } from './canvas-view';

export function CanvasArea() {
  const controller = useController();
  const activeId = useWorkspace((w) => w.active?.id ?? null);
  const dropActive = useUi((s) => s.dropActive);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const antsRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<CanvasView | null>(null);
  const shownRef = useRef<DocumentSession | null>(null);

  useEffect(() => {
    const ui = useUi.getState();
    let frame = 0;
    const view = new CanvasView(hostRef.current!, canvasRef.current!, overlayRef.current!, {
      tools: controller.tools,
      getActiveToolId: () => useUi.getState().activeToolId,
      onGestureStart: () => controller.keyboard.pointerUsed(),
      execute: (descriptor) => void controller.runDocumentCommand(descriptor),
      ants: { canvas: antsRef.current!, trace: controller.services.traceOutline },
      onViewChange: (state) => {
        // Publish view changes to panels and the status bar at most once per frame.
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          ui.setView(view.renderer.document ? view.viewState : null);
        });
        void state;
      },
    });
    viewRef.current = view;
    controller.attachCanvas(view);
    const unsubscribe = useUi.subscribe((s, prev) => {
      if (s.activeToolId !== prev.activeToolId) view.toolChanged();
    });
    const uninstallDrop = installFileDrop(
      hostRef.current!,
      (files) =>
        void Promise.all(files.map(async (f) => ({ name: f.name, bytes: await readFile(f) }))).then((picked) =>
          controller.openFiles(picked),
        ),
      (active) => useUi.getState().setDropActive(active),
    );
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      uninstallDrop();
      controller.attachCanvas(null);
      view.dispose();
      viewRef.current = null;
    };
  }, [controller]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = shownRef.current;
    if (previous) previous.view = view.viewState;
    const session = controller.workspace.active;
    shownRef.current = session;
    view.setDocument(session?.doc ?? null, session?.view ?? undefined);
    useUi.getState().setView(session ? view.viewState : null);
  }, [activeId, controller]);

  return (
    <div className="canvas-area" ref={hostRef} data-testid="canvas-area">
      <canvas ref={canvasRef} className="document-canvas" aria-label="Document canvas" />
      <canvas ref={antsRef} className="selection-overlay" aria-hidden="true" />
      <div ref={overlayRef} className="zoom-marquee" />
      {!activeId && (
        <div className="empty-state">
          <p>Open an image to start.</p>
          <button type="button" className="primary-button" onClick={() => controller.commands.run('file.open')}>
            <Icon name="open" size={16} /> Open…
          </button>
          <p className="hint">You can also drop PNG, JPEG or WebP files here.</p>
        </div>
      )}
      {dropActive && <div className="drop-highlight">Drop to open</div>}
    </div>
  );
}
