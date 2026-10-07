/**
 * WebP Options (after Save As chooses WebP): Lossless, or Lossy with a quality of
 * 0–100 where the browser can encode it. The estimated file size updates as options
 * change.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { formatImageBytes } from '../../core/document/units';
import type { WebpSaveOptions } from '../../io/webp-options';
import { NumberField } from '../controls/NumberField';
import { useUi, type DialogRequest } from '../state/ui-store';
import { Modal } from './Modal';

export function WebpOptionsDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'webp-options' }> }) {
  const close = useUi((s) => s.closeDialog);
  const [options, setOptions] = useState<WebpSaveOptions>(
    dialog.lossySupported ? dialog.options : { ...dialog.options, lossless: true },
  );
  const [estimate, setEstimate] = useState<{ options: WebpSaveOptions; bytes: number } | null>(null);
  const set = (changes: Partial<WebpSaveOptions>) => setOptions((o) => ({ ...o, ...changes }));

  // The size the file would have (encoded in the worker, a moment after the last change).
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      dialog.estimate(options).then(
        (bytes) => current && setEstimate({ options, bytes }),
        () => {},
      );
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [dialog, options]);

  const cancel = () => (close(dialog), dialog.resolve(null));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    close(dialog);
    dialog.resolve(options);
  };

  return (
    <Modal title="WebP Options" onCancel={cancel}>
      <form className="dialog-form" onSubmit={submit}>
        <fieldset className="dialog-fieldset">
          <legend>Compression</legend>
          <label className="option-check">
            <input
              type="radio"
              name="webp-compression"
              checked={!options.lossless}
              disabled={!dialog.lossySupported}
              data-autofocus={dialog.lossySupported || undefined}
              onChange={() => set({ lossless: false })}
            />
            Lossy (smaller files)
          </label>
          <label className="option-check">
            <input
              type="radio"
              name="webp-compression"
              checked={options.lossless}
              data-autofocus={!dialog.lossySupported || undefined}
              onChange={() => set({ lossless: true })}
            />
            Lossless (exact)
          </label>
          {!dialog.lossySupported && (
            <p className="hint">This browser cannot make lossy WebP files; Chrome, Edge and Firefox can.</p>
          )}
        </fieldset>
        <div className="size-row">
          <NumberField
            label="Quality"
            value={options.quality}
            min={0}
            max={100}
            width={44}
            disabled={options.lossless}
            onChange={(q) => set({ quality: q })}
          />
          <input
            type="range"
            aria-label="Quality slider"
            min={0}
            max={100}
            value={options.quality}
            disabled={options.lossless}
            onChange={(e) => set({ quality: Number(e.target.value) })}
          />
        </div>
        <p className="hint" aria-live="polite">
          Size: {estimate?.options === options ? `about ${formatImageBytes(estimate.bytes)}` : 'estimating…'}
        </p>
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
