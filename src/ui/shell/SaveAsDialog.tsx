/**
 * File > Save As: the file name and the format. Formats the document cannot be
 * saved in (e.g. PNG for a 32-bit image) are listed with the reason and cannot be
 * chosen; saving a layered image in a format without layers says it will be
 * flattened. Where the file goes is chosen next, in the browser's save dialog.
 */
import { useState, type FormEvent } from 'react';
import { useUi, type DialogRequest } from '../state/ui-store';
import { Modal } from './Modal';

export function SaveAsDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'save-as' }> }) {
  const close = useUi((s) => s.closeDialog);
  const [name, setName] = useState(dialog.name);
  const [format, setFormat] = useState(dialog.format);
  const chosen = dialog.formats.find((f) => f.id === format)!;
  const cancel = () => (close(dialog), dialog.resolve(null));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (chosen.restriction || name.trim() === '') return;
    close(dialog);
    dialog.resolve({ name: name.trim(), format });
  };
  return (
    <Modal title="Save As" onCancel={cancel}>
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
          <span>Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            {dialog.formats.map((f) => (
              <option key={f.id} value={f.id} disabled={f.restriction !== null}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        {chosen.restriction && <p className="hint">{chosen.restriction}</p>}
        {!chosen.restriction && !chosen.keepsLayers && dialog.layered && (
          <p className="hint">This format has no layers: the saved file is a flattened copy of the image.</p>
        )}
        <div className="modal-buttons">
          <button type="submit" className="primary-button" disabled={!!chosen.restriction || name.trim() === ''}>
            Save
          </button>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
