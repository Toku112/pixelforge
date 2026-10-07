/** Modal dialogs requested through the UI store (alerts, prompts, layer dialogs, Color Picker, About). */
import { useState, type FormEvent } from 'react';
import { APP_NAME } from '../../app/brand';
import type { BlendMode } from '../../core/document/layers';
import { BlendModeOptions } from '../controls/BlendModeOptions';
import { NumberField } from '../controls/NumberField';
import { ColorPickerDialog } from './ColorPicker';
import { FillDialog } from './FillDialog';
import { Modal } from './Modal';
import { remember, useUi, type DialogRequest } from '../state/ui-store';

function LayerOptionsDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'layer-options' }> }) {
  const close = useUi((s) => s.closeDialog);
  const [name, setName] = useState(dialog.name);
  const [blendMode, setBlendMode] = useState(dialog.blendMode);
  const [opacity, setOpacity] = useState(Math.round(dialog.opacity * 100));
  const cancel = () => (close(dialog), dialog.resolve(null));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    close(dialog);
    dialog.resolve({ name: name.trim() === '' ? dialog.name : name, blendMode, opacity: opacity / 100 });
  };
  return (
    <Modal title={dialog.title} onCancel={cancel}>
      <form className="dialog-form" onSubmit={submit}>
        <label className="dialog-field">
          <span>Name</span>
          <input
            type="text"
            value={name}
            data-autofocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="dialog-field">
          <span>Mode</span>
          <select value={blendMode} onChange={(e) => setBlendMode(e.target.value as BlendMode)}>
            <BlendModeOptions modes={dialog.blendModes} />
          </select>
        </label>
        <div className="dialog-field">
          <span aria-hidden="true" />
          <NumberField label="Opacity" value={opacity} onChange={setOpacity} min={0} max={100} suffix="%" />
        </div>
        <div className="modal-buttons">
          <button type="submit" className="primary-button">
            OK
          </button>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DuplicateLayerDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'duplicate-layer' }> }) {
  const close = useUi((s) => s.closeDialog);
  const [name, setName] = useState(dialog.name);
  const cancel = () => (close(dialog), dialog.resolve(null));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    close(dialog);
    dialog.resolve(dialog.source === null || name.trim() === '' ? {} : { name });
  };
  return (
    <Modal title={dialog.source === null ? 'Duplicate Layers' : 'Duplicate Layer'} onCancel={cancel}>
      <form className="dialog-form" onSubmit={submit}>
        <p>Duplicate: {dialog.source ?? 'the selected layers'}</p>
        {dialog.source !== null && (
          <label className="dialog-field">
            <span>As</span>
            <input
              type="text"
              value={name}
              data-autofocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        <div className="modal-buttons">
          <button type="submit" className="primary-button" data-autofocus={dialog.source === null || undefined}>
            OK
          </button>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'confirm' }> }) {
  const close = useUi((s) => s.closeDialog);
  const [dontAsk, setDontAsk] = useState(false);
  const answer = (ok: boolean) => {
    if (ok && dontAsk && dialog.rememberKey) remember(dialog.rememberKey);
    close(dialog);
    dialog.resolve(ok);
  };
  return (
    <Modal title={dialog.title} onCancel={() => answer(false)}>
      <p>{dialog.message}</p>
      {dialog.rememberKey && (
        <label className="option-check">
          <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
          Don’t show again
        </label>
      )}
      <div className="modal-buttons">
        <button type="button" className="primary-button" data-autofocus onClick={() => answer(true)}>
          {dialog.confirmLabel}
        </button>
        <button type="button" onClick={() => answer(false)}>
          Cancel
        </button>
      </div>
    </Modal>
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
    case 'layer-options':
      return <LayerOptionsDialog dialog={dialog} />;
    case 'duplicate-layer':
      return <DuplicateLayerDialog dialog={dialog} />;
    case 'confirm':
      return <ConfirmDialog dialog={dialog} />;
    case 'color-picker':
      return <ColorPickerDialog dialog={dialog} />;
    case 'fill':
      return <FillDialog dialog={dialog} />;
    case 'about': {
      const done = () => (close(dialog), dialog.resolve());
      return (
        <Modal title={`About ${APP_NAME}`} onCancel={done}>
          <p>
            {APP_NAME} {__APP_VERSION__}
          </p>
          <p>A professional raster image editor that runs in your browser. Your images stay on your computer.</p>
          <p className="hint">
            Built with open-source software including React, Zustand, Vite, Rust, wasm-bindgen, rayon, png, zune-jpeg
            and image-webp (MIT / Apache-2.0 licences).
          </p>
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

const dialogKeys = new WeakMap<DialogRequest, number>();
let nextDialogKey = 1;

/** All open dialogs, stacked (a dialog can open another, e.g. Fill → Color Picker). */
export function Dialogs() {
  const dialogs = useUi((s) => s.dialogs);
  return (
    <>
      {dialogs.map((dialog) => {
        let key = dialogKeys.get(dialog);
        if (key === undefined) dialogKeys.set(dialog, (key = nextDialogKey++));
        return <DialogView key={key} dialog={dialog} />;
      })}
    </>
  );
}
