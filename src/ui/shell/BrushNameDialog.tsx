/** Edit > Define Brush Preset: name the new brush tip (with a small preview of it). */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useUi, type DialogRequest } from '../state/ui-store';
import { Modal } from './Modal';

/** Preview box, CSS pixels. */
const BOX = 96;

export function BrushNameDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'brush-name' }> }) {
  const close = useUi((s) => s.closeDialog);
  const [name, setName] = useState(dialog.name);
  const canvas = useRef<HTMLCanvasElement>(null);

  // The tip as dark paint on white, sampled down to the box (never more than BOX² pixels of work).
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const { width, height, data } = dialog.tip;
    const scale = Math.min(1, BOX / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    el.width = w;
    el.height = h;
    const image = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v =
          255 - data[Math.min(height - 1, Math.floor(y / scale)) * width + Math.min(width - 1, Math.floor(x / scale))]!;
        image.data.set([v, v, v, 255], (y * w + x) * 4);
      }
    }
    ctx.putImageData(image, 0, 0);
  }, [dialog.tip]);

  const cancel = () => (close(dialog), dialog.resolve(null));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    close(dialog);
    dialog.resolve(name.trim() === '' ? dialog.name : name.trim());
  };
  return (
    <Modal title="Brush Name" onCancel={cancel}>
      <form className="dialog-form" onSubmit={submit}>
        <div className="brush-name-row">
          <div className="brush-preview" aria-label="Brush tip preview" role="img">
            <canvas ref={canvas} />
            <span className="hint">
              {dialog.tip.width} × {dialog.tip.height}
            </span>
          </div>
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
