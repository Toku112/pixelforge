/**
 * File > New: preset categories across the top (Recent, Saved, then our preset sizes),
 * the category's presets on the left, and the chosen preset's details on the right —
 * name, size and unit, orientation, resolution, colour mode and bit depth, background
 * contents — all editable before Create. The details can be saved as a preset.
 */
import { useState, type FormEvent } from 'react';
import type { RGB } from '../../core/color/color';
import {
  BACKGROUND_CONTENTS,
  DEFAULT_DOCUMENT_PRESET,
  NEW_DOCUMENT_MODES,
  PRESET_CATEGORIES,
  SIZE_UNITS,
  convertSize,
  newDocumentBytes,
  newDocumentProblem,
  pixelSize,
  type BackgroundContents,
  type DocumentPreset,
  type NewDocumentMode,
  type NewDocumentSettings,
  type SizeUnit,
} from '../../core/document/new-document';
import type { BitDepth } from '../../core/document/pixel-format';
import { formatImageBytes, fromPpi, toPpi, unitDecimals, type ResolutionUnit } from '../../core/document/units';
import { NumberField } from '../controls/NumberField';
import { useUi, type DialogRequest } from '../state/ui-store';
import { Modal } from './Modal';

const round = (v: number, decimals: number) => Number(v.toFixed(decimals));
const cssColor = ({ r, g, b }: RGB) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
const UNIT_SHORT: Record<SizeUnit, string> = {
  pixels: 'px',
  inches: 'in',
  centimeters: 'cm',
  millimeters: 'mm',
  points: 'pt',
  picas: 'pc',
};

/** "7 × 5 in @ 300 ppi" */
function sizeText(s: NewDocumentSettings): string {
  const d = unitDecimals(s.unit);
  const size = `${round(s.width, d)} × ${round(s.height, d)} ${UNIT_SHORT[s.unit]}`;
  return s.unit === 'pixels' ? size : `${size} @ ${round(s.resolution, 3)} ppi`;
}

export function NewDocumentDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'new-document' }> }) {
  const close = useUi((s) => s.closeDialog);
  const pushDialog = useUi((s) => s.pushDialog);
  const [category, setCategory] = useState('recent');
  const [saved, setSaved] = useState(dialog.saved);
  const [name, setName] = useState(dialog.name);
  const [settings, setSettings] = useState(dialog.settings);
  // The preset the details show (null once a value is changed: "Custom").
  const [chosen, setChosen] = useState<DocumentPreset | null>(dialog.recent[0] ?? DEFAULT_DOCUMENT_PRESET);

  const recent = dialog.recent.length > 0 ? dialog.recent : [DEFAULT_DOCUMENT_PRESET];
  const categories = [
    { id: 'recent', label: 'Recent', presets: recent },
    { id: 'saved', label: 'Saved', presets: saved },
    ...PRESET_CATEGORIES,
  ];
  const current = categories.find((c) => c.id === category) ?? categories[0]!;

  const change = (changes: Partial<NewDocumentSettings>) => {
    setSettings((s) => ({ ...s, ...changes }));
    setChosen(null);
  };
  const choose = (p: DocumentPreset) => {
    setSettings(p.settings);
    setChosen(p);
  };
  const setUnit = (unit: SizeUnit) => {
    // Another unit shows the same size: not a change of preset.
    setSettings((s) => convertSize(s, unit));
  };
  const setResolution = (value: number) => {
    const ppi = toPpi(value, settings.resolutionUnit);
    // Pixel sizes stay; physical sizes stay too (and so get more or fewer pixels).
    change({ resolution: ppi });
  };
  const orient = (portrait: boolean) => {
    const isPortrait = settings.height >= settings.width;
    if (portrait !== isPortrait) change({ width: settings.height, height: settings.width });
  };
  const chooseBackground = (value: BackgroundContents) => {
    if (value !== 'custom') {
      change({ background: value });
      return;
    }
    pickCustom();
  };
  const pickCustom = () =>
    pushDialog({
      kind: 'color-picker',
      title: 'Color Picker (Custom Background Color)',
      color: settings.customColor,
      resolve: (color) => {
        if (color) change({ background: 'custom', customColor: color });
      },
    });
  const savePreset = () =>
    pushDialog({
      kind: 'name',
      title: 'Save Document Preset',
      name: chosen?.name ?? name,
      resolve: (answer) => {
        if (!answer) return;
        const id =
          typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `preset-${Date.now()}`;
        const preset = { id, name: answer.name, settings };
        void dialog.savePreset(preset).then((list) => {
          setSaved(list);
          setChosen(preset);
          setCategory('saved');
        });
      },
    });
  const deletePreset = (p: DocumentPreset) =>
    void dialog.deletePreset(p.id).then((list) => {
      setSaved(list);
      if (chosen?.id === p.id) setChosen(null);
    });

  const problem = newDocumentProblem(settings);
  const px = pixelSize(settings);
  const decimals = unitDecimals(settings.unit);
  const swatch =
    settings.background === 'white'
      ? '#fff'
      : settings.background === 'black'
        ? '#000'
        : settings.background === 'background'
          ? cssColor(dialog.background)
          : settings.background === 'custom'
            ? cssColor(settings.customColor)
            : undefined;

  const cancel = () => (close(dialog), dialog.resolve(null));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    close(dialog);
    dialog.resolve({
      name: name.trim() === '' ? dialog.name : name.trim(),
      presetName: chosen?.name ?? 'Custom',
      settings,
    });
  };

  return (
    <Modal title="New Document" onCancel={cancel} className="new-document">
      <form className="dialog-form" onSubmit={submit}>
        <div className="new-document-tabs" role="tablist" aria-label="Preset categories">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={c.id === current.id}
              className={c.id === current.id ? 'active' : undefined}
              onClick={() => setCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="new-document-body">
          <div className="new-document-presets" role="listbox" aria-label={`${current.label} presets`}>
            {current.presets.length === 0 && (
              <p className="hint">
                {current.id === 'saved' ? 'Presets you save with the details on the right appear here.' : 'None yet.'}
              </p>
            )}
            {current.presets.map((p) => (
              <div
                key={p.id}
                role="option"
                tabIndex={0}
                aria-selected={chosen?.id === p.id}
                className={chosen?.id === p.id ? 'new-document-preset active' : 'new-document-preset'}
                onClick={() => choose(p)}
                onDoubleClick={() => {
                  choose(p);
                  if (!newDocumentProblem(p.settings)) {
                    close(dialog);
                    dialog.resolve({
                      name: name.trim() === '' ? dialog.name : name.trim(),
                      presetName: p.name,
                      settings: p.settings,
                    });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    choose(p);
                  }
                }}
              >
                <span className="new-document-preset-name">{p.name}</span>
                <span className="new-document-preset-size">{sizeText(p.settings)}</span>
              </div>
            ))}
          </div>
          <fieldset className="new-document-details">
            <legend>Preset Details</legend>
            <div className="new-document-name">
              <input
                type="text"
                aria-label="Document name"
                value={name}
                data-autofocus
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setName(e.target.value)}
              />
              <button type="button" title="Save Document Preset" aria-label="Save document preset" onClick={savePreset}>
                Save
              </button>
              {current.id === 'saved' && chosen && saved.some((p) => p.id === chosen.id) && (
                <button
                  type="button"
                  title="Delete Saved Preset"
                  aria-label="Delete saved preset"
                  onClick={() => deletePreset(chosen)}
                >
                  Delete
                </button>
              )}
            </div>
            <div className="size-row">
              <NumberField
                label="Width"
                value={round(settings.width, decimals)}
                precision={decimals}
                min={0.001}
                width={80}
                onChange={(v) => change({ width: v })}
              />
              <select
                aria-label="Size unit"
                value={settings.unit}
                onChange={(e) => setUnit(e.target.value as SizeUnit)}
              >
                {SIZE_UNITS.map(({ unit, label }) => (
                  <option key={unit} value={unit}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="size-row">
              <NumberField
                label="Height"
                value={round(settings.height, decimals)}
                precision={decimals}
                min={0.001}
                width={80}
                onChange={(v) => change({ height: v })}
              />
              <div className="new-document-orientation" role="group" aria-label="Orientation">
                <button
                  type="button"
                  aria-label="Portrait"
                  title="Portrait"
                  aria-pressed={settings.height >= settings.width}
                  onClick={() => orient(true)}
                >
                  <span className="orientation-icon portrait" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Landscape"
                  title="Landscape"
                  aria-pressed={settings.width > settings.height}
                  onClick={() => orient(false)}
                >
                  <span className="orientation-icon landscape" aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="size-row">
              <NumberField
                label="Resolution"
                value={round(fromPpi(settings.resolution, settings.resolutionUnit), 3)}
                precision={3}
                min={0.001}
                max={300000}
                width={80}
                onChange={setResolution}
              />
              <select
                aria-label="Resolution unit"
                value={settings.resolutionUnit}
                onChange={(e) => setSettings((s) => ({ ...s, resolutionUnit: e.target.value as ResolutionUnit }))}
              >
                <option value="ppi">Pixels/Inch</option>
                <option value="ppcm">Pixels/Centimeter</option>
              </select>
            </div>
            <div className="size-row">
              <span className="number-field-label">Color Mode</span>
              <select
                aria-label="Color mode"
                value={settings.mode}
                onChange={(e) => change({ mode: e.target.value as NewDocumentMode })}
              >
                {NEW_DOCUMENT_MODES.map(({ mode, label }) => (
                  <option key={mode} value={mode}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Bit depth"
                value={settings.depth}
                onChange={(e) => change({ depth: Number(e.target.value) as BitDepth })}
              >
                <option value={8}>8 bit</option>
                <option value={16}>16 bit</option>
                <option value={32}>32 bit</option>
              </select>
            </div>
            <div className="size-row">
              <span className="number-field-label">Background</span>
              <select
                aria-label="Background contents"
                value={settings.background}
                onChange={(e) => chooseBackground(e.target.value as BackgroundContents)}
              >
                {BACKGROUND_CONTENTS.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={swatch ? 'color-chip' : 'color-chip transparent-chip'}
                aria-label="Custom background color"
                title="Choose a custom background colour"
                style={swatch ? { background: swatch } : undefined}
                onClick={pickCustom}
              />
            </div>
            <p className="new-document-readout">
              {problem ?? `${formatImageBytes(newDocumentBytes(settings))} — ${px.width} × ${px.height} px`}
            </p>
          </fieldset>
        </div>
        <div className="modal-buttons">
          <button type="submit" className="primary-button" disabled={!!problem}>
            Create
          </button>
          <button type="button" onClick={cancel}>
            Close
          </button>
        </div>
      </form>
    </Modal>
  );
}
