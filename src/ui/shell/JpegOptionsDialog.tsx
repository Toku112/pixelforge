/**
 * JPEG Options (after Save As chooses JPEG): quality 0–12 with presets, the format
 * (Baseline, Baseline Optimized, Progressive with 3–5 scans) and, for images with
 * transparency, the matte colour. The estimated file size updates as options change.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { formatImageBytes } from '../../core/document/units';
import { JPEG_PRESETS, jpegPreset, type JpegFormat, type JpegSaveOptions } from '../../io/jpeg-options';
import { NumberField } from '../controls/NumberField';
import { useUi, type DialogRequest } from '../state/ui-store';
import { Modal } from './Modal';

const FORMATS: [JpegFormat, string][] = [
  ['baseline', 'Baseline ("Standard")'],
  ['optimized', 'Baseline Optimized'],
  ['progressive', 'Progressive'],
];

const MATTES: [string, string, { r: number; g: number; b: number } | null][] = [
  ['white', 'White', { r: 1, g: 1, b: 1 }],
  ['black', 'Black', { r: 0, g: 0, b: 0 }],
  ['foreground', 'Foreground Color', null],
  ['background', 'Background Color', null],
];

export function JpegOptionsDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'jpeg-options' }> }) {
  const close = useUi((s) => s.closeDialog);
  const [options, setOptions] = useState<JpegSaveOptions>(dialog.options);
  const [matte, setMatte] = useState('white');
  const [estimate, setEstimate] = useState<{ options: JpegSaveOptions; bytes: number } | null>(null);
  const set = (changes: Partial<JpegSaveOptions>) => setOptions((o) => ({ ...o, ...changes }));

  const matteColor = (id: string) =>
    id === 'foreground'
      ? dialog.foreground
      : id === 'background'
        ? dialog.background
        : MATTES.find((m) => m[0] === id)![2]!;

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
    <Modal title="JPEG Options" onCancel={cancel}>
      <form className="dialog-form" onSubmit={submit}>
        {dialog.hasTransparency && (
          <label className="dialog-field">
            <span>Matte</span>
            <select
              value={matte}
              onChange={(e) => {
                setMatte(e.target.value);
                set({ matte: matteColor(e.target.value) });
              }}
            >
              {MATTES.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="size-row">
          <NumberField
            label="Quality"
            autofocus
            value={options.quality}
            min={0}
            max={12}
            width={44}
            onChange={(q) => set({ quality: q })}
          />
          <select
            aria-label="Quality preset"
            value={jpegPreset(options.quality)}
            onChange={(e) => set({ quality: JPEG_PRESETS.find((p) => p.id === e.target.value)!.quality })}
          >
            {JPEG_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <input
          type="range"
          aria-label="Quality slider"
          min={0}
          max={12}
          step={1}
          value={options.quality}
          onChange={(e) => set({ quality: Number(e.target.value) })}
        />
        <fieldset className="dialog-fieldset">
          <legend>Format Options</legend>
          {FORMATS.map(([id, label]) => (
            <label key={id} className="option-check">
              <input
                type="radio"
                name="jpeg-format"
                checked={options.format === id}
                onChange={() => set({ format: id })}
              />
              {label}
            </label>
          ))}
          <label className="dialog-field">
            <span>Scans</span>
            <select
              value={options.scans}
              disabled={options.format !== 'progressive'}
              onChange={(e) => set({ scans: Number(e.target.value) as 3 | 4 | 5 })}
            >
              {[3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
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
