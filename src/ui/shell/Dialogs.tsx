/** Modal dialogs requested through the UI store (alerts, unsaved-changes prompt, About). */
import { useEffect, useRef, type ReactNode } from 'react';
import { APP_NAME } from '../../app/brand';
import { useUi, type DialogRequest } from '../state/ui-store';

function Modal({ title, children, onCancel }: { title: string; children: ReactNode; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Tab' && el) {
        // Keep focus inside the dialog.
        const focusable = [...el.querySelectorAll<HTMLElement>('button, [href], input')];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref}>
        <h2 id="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function DialogView({ dialog }: { dialog: DialogRequest }) {
  const close = useUi((s) => s.closeDialog);
  switch (dialog.kind) {
    case 'alert': {
      const done = () => (close(dialog), dialog.resolve());
      return (
        <Modal title={dialog.title} onCancel={done}>
          <p>{dialog.message}</p>
          <div className="modal-buttons">
            <button type="button" className="primary-button" data-autofocus onClick={done}>
              OK
            </button>
          </div>
        </Modal>
      );
    }
    case 'confirm-save': {
      const answer = (a: 'save' | 'discard' | 'cancel') => (close(dialog), dialog.resolve(a));
      return (
        <Modal title={APP_NAME} onCancel={() => answer('cancel')}>
          <p>Save changes to “{dialog.documentName}” before closing?</p>
          <div className="modal-buttons">
            <button type="button" className="primary-button" data-autofocus onClick={() => answer('save')}>
              Save
            </button>
            <button type="button" onClick={() => answer('discard')}>
              Don’t Save
            </button>
            <button type="button" onClick={() => answer('cancel')}>
              Cancel
            </button>
          </div>
        </Modal>
      );
    }
    case 'about': {
      const done = () => (close(dialog), dialog.resolve());
      return (
        <Modal title={`About ${APP_NAME}`} onCancel={done}>
          <p>
            {APP_NAME} {__APP_VERSION__}
          </p>
          <p>A professional raster image editor that runs in your browser. Your images stay on your computer.</p>
          <p className="hint">Built with open-source software including React, Zustand, Vite, Rust, wasm-bindgen, rayon, png, zune-jpeg and image-webp (MIT / Apache-2.0 licences).</p>
          <div className="modal-buttons">
            <button type="button" className="primary-button" data-autofocus onClick={done}>
              OK
            </button>
          </div>
        </Modal>
      );
    }
  }
}

export function Dialogs() {
  const dialog = useUi((s) => s.dialogs[0]);
  return dialog ? <DialogView dialog={dialog} /> : null;
}
