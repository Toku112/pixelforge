/** Export Brushes: which groups go into the brush file. */
import { useState, type FormEvent } from 'react';
import { useUi, type DialogRequest } from '../state/ui-store';
import { Modal } from './Modal';

export function ExportBrushesDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'export-brushes' }> }) {
  const close = useUi((s) => s.closeDialog);
  const [chosen, setChosen] = useState<string[]>(dialog.selected);
  const cancel = () => (close(dialog), dialog.resolve(null));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    close(dialog);
    dialog.resolve(dialog.groups.filter((g) => chosen.includes(g)));
  };
  return (
    <Modal title="Export Brushes" onCancel={cancel}>
      <form className="dialog-form" onSubmit={submit}>
        <fieldset className="dialog-fieldset">
          <legend>Groups</legend>
          {dialog.groups.map((g) => (
            <label key={g} className="option-check">
              <input
                type="checkbox"
                checked={chosen.includes(g)}
                onChange={(e) => setChosen(e.target.checked ? [...chosen, g] : chosen.filter((c) => c !== g))}
              />
              {g === '' ? 'Brushes outside groups' : g}
            </label>
          ))}
        </fieldset>
        <div className="modal-buttons">
          <button type="submit" className="primary-button" disabled={chosen.length === 0}>
            Export
          </button>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
