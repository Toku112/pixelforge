/** Radial / Mandala symmetry: how many segments (2–12). */
import { useState, type FormEvent } from 'react';
import { NumberField } from '../controls/NumberField';
import { useUi, type DialogRequest } from '../state/ui-store';
import { Modal } from './Modal';

export function SymmetrySegmentsDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'symmetry-segments' }> }) {
  const close = useUi((s) => s.closeDialog);
  const [segments, setSegments] = useState(dialog.segments);
  const cancel = () => (close(dialog), dialog.resolve(null));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    close(dialog);
    dialog.resolve(segments);
  };
  return (
    <Modal title={dialog.symmetry === 'radial' ? 'Radial Symmetry' : 'Mandala Symmetry'} onCancel={cancel}>
      <form className="dialog-form" onSubmit={submit}>
        <NumberField
          label="Segment Count:"
          value={segments}
          min={2}
          max={12}
          width={48}
          autofocus
          onChange={(v) => setSegments(Math.round(v))}
        />
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
