/** Asks for a name (New Brush Preset, New Brush Group, Rename, New Tool Preset…), with an optional checkbox. */
import { useState, type FormEvent } from 'react';
import { useUi, type DialogRequest } from '../state/ui-store';
import { Modal } from './Modal';

export function NameDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'name' }> }) {
  const close = useUi((s) => s.closeDialog);
  const [name, setName] = useState(dialog.name);
  const [option, setOption] = useState(dialog.option?.checked ?? false);
  const cancel = () => (close(dialog), dialog.resolve(null));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    close(dialog);
    dialog.resolve({ name: name.trim() === '' ? dialog.name : name.trim(), option });
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
        {dialog.option && (
          <label className="option-check">
            <input type="checkbox" checked={option} onChange={(e) => setOption(e.target.checked)} />
            {dialog.option.label}
          </label>
        )}
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
