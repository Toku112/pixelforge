/**
 * Edit > Fill: what to fill with (foreground, background, a picked colour, a
 * pattern, the History Brush source, black, 50 % gray or white), the blend mode and
 * opacity, and Preserve Transparency. Choosing "Color…" opens the Color Picker
 * straight away; "Pattern" shows a pattern picker.
 */
import { useState, type FormEvent } from 'react';
import type { RGB } from '../../core/color/color';
import type { LayerBlendMode } from '../../core/document/layers';
import { NumberField } from '../controls/NumberField';
import { useUi, type DialogRequest, type FillContents } from '../state/ui-store';
import { BlendModeOptions } from '../controls/BlendModeOptions';
import { Modal } from './Modal';
import { PatternPicker } from './PatternPicker';

const CONTENTS: [FillContents, string][] = [
  ['foreground', 'Foreground Color'],
  ['background', 'Background Color'],
  ['color', 'Color…'],
  ['pattern', 'Pattern'],
  ['history', 'History'],
  ['black', 'Black'],
  ['gray', '50% Gray'],
  ['white', 'White'],
];

const GRAY = 128 / 255;

export function FillDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'fill' }> }) {
  const close = useUi((s) => s.closeDialog);
  const pushDialog = useUi((s) => s.pushDialog);
  const [contents, setContents] = useState<FillContents>(dialog.contents);
  const [picked, setPicked] = useState<RGB>(dialog.foreground);
  const [mode, setMode] = useState<LayerBlendMode>('normal');
  const [opacity, setOpacity] = useState(100);
  const [preserve, setPreserve] = useState(dialog.preserve && dialog.canPreserve);
  const [pattern, setPattern] = useState(dialog.pattern);

  const colorFor = (c: FillContents): RGB => {
    switch (c) {
      case 'foreground':
        return dialog.foreground;
      case 'background':
        return dialog.background;
      case 'color':
        return picked;
      case 'pattern': // not used: the pattern fills
      case 'history': // not used: the history state fills
      case 'black':
        return { r: 0, g: 0, b: 0 };
      case 'gray':
        return { r: GRAY, g: GRAY, b: GRAY };
      case 'white':
        return { r: 1, g: 1, b: 1 };
    }
  };

  const choose = (c: FillContents) => {
    if (c !== 'color') {
      setContents(c);
      return;
    }
    pushDialog({
      kind: 'color-picker',
      title: 'Color Picker (Fill Color)',
      color: picked,
      resolve: (color) => {
        if (!color) return; // keep the previous choice
        setPicked(color);
        setContents('color');
      },
    });
  };

  const cancel = () => (close(dialog), dialog.resolve(null));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    close(dialog);
    dialog.resolve({
      color: colorFor(contents),
      mode,
      opacity: opacity / 100,
      preserveTransparency: preserve,
      ...(contents === 'pattern' ? { pattern } : {}),
      ...(contents === 'history' ? { history: true } : {}),
    });
  };

  return (
    <Modal title="Fill" onCancel={cancel}>
      <form className="dialog-form" onSubmit={submit}>
        <label className="dialog-field">
          <span>Contents</span>
          <select value={contents} data-autofocus onChange={(e) => choose(e.target.value as FillContents)}>
            {CONTENTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {contents === 'pattern' && (
          <div className="dialog-field">
            <span>Pattern</span>
            <PatternPicker value={pattern} onChange={setPattern} label="Custom pattern" />
          </div>
        )}
        <label className="dialog-field">
          <span>Mode</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as LayerBlendMode)}>
            <BlendModeOptions modes={dialog.blendModes} />
          </select>
        </label>
        <div className="dialog-field">
          <span aria-hidden="true" />
          <NumberField label="Opacity" value={opacity} onChange={setOpacity} min={0} max={100} suffix="%" />
        </div>
        <label className="option-check">
          <input
            type="checkbox"
            checked={preserve}
            disabled={!dialog.canPreserve}
            onChange={(e) => setPreserve(e.target.checked)}
          />
          Preserve Transparency
        </label>
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
