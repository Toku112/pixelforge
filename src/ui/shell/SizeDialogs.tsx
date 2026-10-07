/**
 * Image > Image Size and Image > Canvas Size.
 *
 * Image Size: pixel dimensions in any length unit, resolution, Constrain
 * Proportions, Resample (off: only the resolution changes, the pixels stay) and the
 * resampling method; Fit To offers common output sizes.
 * Canvas Size: the new canvas size (absolute or Relative to the current one), the
 * anchor (where the image stays) and the colour of new canvas on the Background.
 */
import { useState, type FormEvent } from 'react';
import type { RGB } from '../../core/color/color';
import type { ResampleMethod } from '../../core/geometry/layer-geometry';
import {
  LENGTH_UNITS,
  formatImageBytes,
  fromPixels,
  fromPpi,
  isPhysicalUnit,
  toPixels,
  toPpi,
  unitDecimals,
  type LengthUnit,
  type ResolutionUnit,
} from '../../core/document/units';
import { NumberField } from '../controls/NumberField';
import { useUi, type DialogRequest } from '../state/ui-store';
import { Modal } from './Modal';

// Remembered while the app is open, as the reference app does between uses.
let lastImageUnit: LengthUnit = 'pixels';
let lastResolutionUnit: ResolutionUnit = 'ppi';
let lastCanvasUnit: LengthUnit = 'pixels';
let lastMethod: ResampleMethod = 'automatic';

function UnitSelect({
  value,
  onChange,
  label,
}: {
  value: LengthUnit;
  onChange: (u: LengthUnit) => void;
  label: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as LengthUnit)}>
      {LENGTH_UNITS.map(({ unit, label }) => (
        <option key={unit} value={unit}>
          {label}
        </option>
      ))}
    </select>
  );
}

const METHODS: [ResampleMethod, string][] = [
  ['automatic', 'Automatic'],
  ['bicubic-smoother', 'Bicubic Smoother (enlargement)'],
  ['bicubic-sharper', 'Bicubic Sharper (reduction)'],
  ['bicubic', 'Bicubic (smooth gradients)'],
  ['nearest', 'Nearest Neighbor (hard edges)'],
  ['bilinear', 'Bilinear'],
];

/** Fit To: a box in pixels at a resolution; the image is scaled to fit it, matching its orientation. */
const FIT_TO: { label: string; w: number; h: number; ppi: number }[] = [
  { label: '640 × 480 px 72 ppi', w: 640, h: 480, ppi: 72 },
  { label: '1280 × 720 px 72 ppi', w: 1280, h: 720, ppi: 72 },
  { label: '1920 × 1080 px 72 ppi', w: 1920, h: 1080, ppi: 72 },
  { label: '3840 × 2160 px 72 ppi', w: 3840, h: 2160, ppi: 72 },
  { label: '4 × 6 in 300 ppi', w: 1200, h: 1800, ppi: 300 },
  { label: '5 × 7 in 300 ppi', w: 1500, h: 2100, ppi: 300 },
  { label: '8 × 10 in 300 ppi', w: 2400, h: 3000, ppi: 300 },
  { label: 'A4 210 × 297 mm 300 ppi', w: 2480, h: 3508, ppi: 300 },
];

const round = (v: number, decimals: number) => Number(v.toFixed(decimals));
const cssColor = ({ r, g, b }: RGB) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;

export function ImageSizeDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'image-size' }> }) {
  const close = useUi((s) => s.closeDialog);
  const { width: w0, height: h0, resolution: res0, bytesPerPixel } = dialog;
  const [px, setPx] = useState({ w: w0, h: h0 });
  const [res, setRes] = useState(res0);
  const [unit, setUnitState] = useState<LengthUnit>(lastImageUnit);
  const [resUnit, setResUnitState] = useState<ResolutionUnit>(lastResolutionUnit);
  const [constrain, setConstrain] = useState(true);
  const [resample, setResample] = useState(true);
  const [method, setMethodState] = useState<ResampleMethod>(lastMethod);
  const [fit, setFit] = useState('original');

  const setUnit = (u: LengthUnit) => setUnitState((lastImageUnit = u));
  const setResUnit = (u: ResolutionUnit) => setResUnitState((lastResolutionUnit = u));
  const setMethod = (m: ResampleMethod) => setMethodState((lastMethod = m));
  const decimals = unitDecimals(unit);
  // Without resampling the pixels stay: only physical sizes (and so the resolution) can change.
  const sizeLocked = !resample && !isPhysicalUnit(unit);

  const setSide = (side: 'w' | 'h', value: number) => {
    setFit('custom');
    const base = side === 'w' ? w0 : h0;
    if (!resample) {
      // The same pixels over a new physical size: a new resolution.
      setRes((base * res) / toPixels(value, unit, res, base));
      return;
    }
    const v = toPixels(value, unit, res, base);
    if (!constrain) setPx((p) => ({ ...p, [side]: v }));
    else if (side === 'w') setPx({ w: v, h: (v * h0) / w0 });
    else setPx({ w: (v * w0) / h0, h: v });
  };
  const setResolution = (value: number) => {
    setFit('custom');
    const r = toPpi(value, resUnit);
    // Resampling keeps the size as shown: physical sizes then need more (or fewer) pixels.
    if (resample && isPhysicalUnit(unit)) setPx((p) => ({ w: (p.w * r) / res, h: (p.h * r) / res }));
    setRes(r);
  };
  const toggleResample = (on: boolean) => {
    setResample(on);
    if (!on) {
      setPx({ w: w0, h: h0 });
      setConstrain(true);
    }
  };
  const toggleConstrain = (on: boolean) => {
    setConstrain(on);
    if (on) setPx((p) => ({ w: p.w, h: (p.w * h0) / w0 }));
  };
  const chooseFit = (value: string) => {
    setFit(value);
    if (value === 'original') {
      setPx({ w: w0, h: h0 });
      setRes(res0);
      return;
    }
    const preset = FIT_TO[Number(value)];
    if (!preset) return;
    const [bw, bh] = preset.w > preset.h === w0 > h0 ? [preset.w, preset.h] : [preset.h, preset.w];
    const scale = Math.min(bw / w0, bh / h0);
    setResample(true);
    setConstrain(true);
    setPx({ w: w0 * scale, h: h0 * scale });
    setRes(preset.ppi);
  };

  const outW = Math.max(1, Math.round(px.w));
  const outH = Math.max(1, Math.round(px.h));
  const cancel = () => (close(dialog), dialog.resolve(null));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    close(dialog);
    dialog.resolve({
      width: resample ? outW : w0,
      height: resample ? outH : h0,
      resolution: res,
      method,
    });
  };

  return (
    <Modal title="Image Size" onCancel={cancel}>
      <form className="dialog-form size-dialog" onSubmit={submit}>
        <p>
          Image Size: {formatImageBytes(outW * outH * bytesPerPixel)}
          {outW !== w0 || outH !== h0 ? ` (was ${formatImageBytes(w0 * h0 * bytesPerPixel)})` : ''}
        </p>
        <p>
          Dimensions: {outW} px × {outH} px
        </p>
        <label className="dialog-field">
          <span>Fit To</span>
          <select value={fit} onChange={(e) => chooseFit(e.target.value)}>
            <option value="original">Original Size</option>
            {fit === 'custom' && <option value="custom">Custom</option>}
            {FIT_TO.map((preset, i) => (
              <option key={preset.label} value={i}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <div className="size-rows">
          <div className="size-row">
            <NumberField
              label="Width"
              autofocus
              value={round(fromPixels(px.w, unit, res, w0), decimals)}
              precision={decimals}
              min={0.001}
              width={72}
              disabled={sizeLocked}
              onChange={(v) => setSide('w', v)}
            />
            <UnitSelect label="Width unit" value={unit} onChange={setUnit} />
          </div>
          <div className="size-row">
            <NumberField
              label="Height"
              value={round(fromPixels(px.h, unit, res, h0), decimals)}
              precision={decimals}
              min={0.001}
              width={72}
              disabled={sizeLocked}
              onChange={(v) => setSide('h', v)}
            />
            <UnitSelect label="Height unit" value={unit} onChange={setUnit} />
          </div>
          <label className="option-check size-constrain">
            <input
              type="checkbox"
              checked={constrain}
              disabled={!resample}
              onChange={(e) => toggleConstrain(e.target.checked)}
            />
            Constrain Proportions
          </label>
          <div className="size-row">
            <NumberField
              label="Resolution"
              value={round(fromPpi(res, resUnit), 3)}
              precision={3}
              min={0.001}
              max={300000}
              width={72}
              onChange={setResolution}
            />
            <select
              aria-label="Resolution unit"
              value={resUnit}
              onChange={(e) => setResUnit(e.target.value as ResolutionUnit)}
            >
              <option value="ppi">Pixels/Inch</option>
              <option value="ppcm">Pixels/Centimeter</option>
            </select>
          </div>
        </div>
        <div className="size-row">
          <label className="option-check">
            <input type="checkbox" checked={resample} onChange={(e) => toggleResample(e.target.checked)} />
            Resample
          </label>
          <select
            aria-label="Resampling method"
            value={method}
            disabled={!resample}
            onChange={(e) => setMethod(e.target.value as ResampleMethod)}
          >
            {METHODS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
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

// ---------------------------------------------------------------------------

export type ExtensionColor = 'foreground' | 'background' | 'white' | 'black' | 'gray' | 'other';

const EXTENSION_COLORS: [ExtensionColor, string][] = [
  ['foreground', 'Foreground'],
  ['background', 'Background'],
  ['white', 'White'],
  ['black', 'Black'],
  ['gray', 'Gray'],
  ['other', 'Other…'],
];

const ANCHOR_NAMES = [
  ['top left', 'top', 'top right'],
  ['left', 'center', 'right'],
  ['bottom left', 'bottom', 'bottom right'],
];
const ARROWS = [
  ['↖', '↑', '↗'],
  ['←', '', '→'],
  ['↙', '↓', '↘'],
];

let lastExtension: ExtensionColor = 'background';
let lastOther: RGB = { r: 1, g: 1, b: 1 };

export function CanvasSizeDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'canvas-size' }> }) {
  const close = useUi((s) => s.closeDialog);
  const pushDialog = useUi((s) => s.pushDialog);
  const { width: w0, height: h0, resolution: ppi, bytesPerPixel } = dialog;
  const [px, setPx] = useState({ w: w0, h: h0 });
  const [relative, setRelative] = useState(false);
  const [unit, setUnitState] = useState<LengthUnit>(lastCanvasUnit);
  const [anchor, setAnchor] = useState<[number, number]>([1, 1]);
  const [extension, setExtension] = useState<ExtensionColor>(lastExtension);
  const [other, setOther] = useState<RGB>(lastOther);
  const setUnit = (u: LengthUnit) => setUnitState((lastCanvasUnit = u));
  const decimals = unitDecimals(unit);

  const colorOf = (c: ExtensionColor): RGB => {
    switch (c) {
      case 'foreground':
        return dialog.foreground;
      case 'background':
        return dialog.background;
      case 'white':
        return { r: 1, g: 1, b: 1 };
      case 'black':
        return { r: 0, g: 0, b: 0 };
      case 'gray':
        return { r: 0.5, g: 0.5, b: 0.5 };
      case 'other':
        return other;
    }
  };
  const chooseExtension = (c: ExtensionColor) => {
    if (c !== 'other') {
      setExtension((lastExtension = c));
      return;
    }
    pushDialog({
      kind: 'color-picker',
      title: 'Color Picker (Canvas Extension Color)',
      color: other,
      resolve: (color) => {
        if (!color) return;
        setOther((lastOther = color));
        setExtension((lastExtension = 'other'));
      },
    });
  };

  // Relative: the fields hold how much to add (or remove, when negative).
  const shown = (side: 'w' | 'h') => {
    const base = side === 'w' ? w0 : h0;
    return round(fromPixels(relative ? px[side] - base : px[side], unit, ppi, base), decimals);
  };
  const setSide = (side: 'w' | 'h', value: number) => {
    const base = side === 'w' ? w0 : h0;
    const v = toPixels(value, unit, ppi, base);
    setPx((p) => ({ ...p, [side]: relative ? base + v : v }));
  };
  const outW = Math.round(px.w);
  const outH = Math.round(px.h);
  const valid = outW >= 1 && outH >= 1 && outW <= 300000 && outH <= 300000;

  const cancel = () => (close(dialog), dialog.resolve(null));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    close(dialog);
    dialog.resolve({
      width: outW,
      height: outH,
      anchor: [anchor[0] / 2, anchor[1] / 2],
      color: colorOf(extension),
    });
  };
  const sizeText = (w: number, h: number) =>
    `${round(fromPixels(w, unit, ppi, w0), decimals)} × ${round(fromPixels(h, unit, ppi, h0), decimals)} ${LENGTH_UNITS.find(
      (u) => u.unit === unit,
    )!.label.toLowerCase()}`;

  return (
    <Modal title="Canvas Size" onCancel={cancel}>
      <form className="dialog-form size-dialog" onSubmit={submit}>
        <p>
          Current Size: {formatImageBytes(w0 * h0 * bytesPerPixel)} — {sizeText(w0, h0)}
        </p>
        <p>New Size: {valid ? formatImageBytes(outW * outH * bytesPerPixel) : '—'}</p>
        <div className="size-rows">
          <div className="size-row">
            <NumberField
              label="Width"
              autofocus
              value={shown('w')}
              precision={decimals}
              width={72}
              onChange={(v) => setSide('w', v)}
            />
            <UnitSelect label="Width unit" value={unit} onChange={setUnit} />
          </div>
          <div className="size-row">
            <NumberField
              label="Height"
              value={shown('h')}
              precision={decimals}
              width={72}
              onChange={(v) => setSide('h', v)}
            />
            <UnitSelect label="Height unit" value={unit} onChange={setUnit} />
          </div>
          <label className="option-check">
            <input type="checkbox" checked={relative} onChange={(e) => setRelative(e.target.checked)} />
            Relative
          </label>
        </div>
        <div className="size-row">
          <span>Anchor</span>
          <div className="anchor-grid" role="group" aria-label="Anchor">
            {ANCHOR_NAMES.map((row, y) =>
              row.map((name, x) => {
                const on = anchor[0] === x && anchor[1] === y;
                // Arrows point away from the anchor, where the canvas grows.
                const dx = x - anchor[0];
                const dy = y - anchor[1];
                const arrow = Math.abs(dx) <= 1 && Math.abs(dy) <= 1 ? ARROWS[dy + 1]![dx + 1]! : '';
                return (
                  <button
                    key={name}
                    type="button"
                    className="anchor-cell"
                    aria-label={`Anchor ${name}`}
                    aria-pressed={on}
                    onClick={() => setAnchor([x, y])}
                  >
                    {on ? '●' : arrow}
                  </button>
                );
              }),
            )}
          </div>
        </div>
        <label className="dialog-field size-extension">
          <span>Canvas extension color</span>
          <select
            value={extension}
            disabled={!dialog.hasBackground}
            onChange={(e) => chooseExtension(e.target.value as ExtensionColor)}
          >
            {EXTENSION_COLORS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <span className="color-chip" aria-hidden="true" style={{ background: cssColor(colorOf(extension)) }} />
        </label>
        {!valid && <p className="hint">Width and height must be 1 to 300000 pixels.</p>}
        <div className="modal-buttons">
          <button type="submit" className="primary-button" disabled={!valid}>
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
