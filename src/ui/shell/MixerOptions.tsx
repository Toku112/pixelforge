/**
 * The Mixer Brush's options bar: the brush, the paint it holds (swatch and menu: Load
 * Brush, Clean Brush, Load Solid Colors Only), loading and cleaning after each stroke,
 * the useful combinations, Wet, Load, Mix, Flow with build-up, smoothing, angle,
 * Sample All Layers, pen pressure for size and paint symmetry. No mode or opacity.
 */
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_DYNAMICS } from '../../core/paint/dynamics';
import { MIXER_COMBINATIONS, mixerCombination, type MixerOptions } from '../../core/paint/mixer';
import type { PaintingTool } from '../../tools/paint/paint-tool';
import { isPanelOpen } from '../dock/dock-model';
import { useController } from '../AppContext';
import { NumberField } from '../controls/NumberField';
import { Icon } from '../icons';
import { useUi } from '../state/ui-store';
import { BrushPicker } from './BrushPicker';
import { SmoothingControls } from './SmoothingControls';
import { SymmetryMenu } from './SymmetryMenu';

const SWATCH = 20;

/** What the brush holds: the foreground colour, the paint taken from the image, or nothing (checks). */
function LoadSwatch({ tool }: { tool: PaintingTool }) {
  const controller = useController();
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = tool.mixerState;
  const fg = controller.colors.foreground;
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = Math.round(SWATCH * ratio);
    c.height = Math.round(SWATCH * ratio);
    ctx.clearRect(0, 0, c.width, c.height);
    if (state.level <= 0) return; // clean: the checks show through
    if (state.load.kind === 'foreground') {
      ctx.fillStyle = `rgb(${fg.r * 255}, ${fg.g * 255}, ${fg.b * 255})`;
      ctx.fillRect(0, 0, c.width, c.height);
      return;
    }
    const p = state.load.preview;
    const image = document.createElement('canvas');
    image.width = p.width;
    image.height = p.height;
    image.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
    ctx.imageSmoothingEnabled = p.width > 1;
    ctx.drawImage(image, 0, 0, c.width, c.height);
  }, [state, fg]);
  return <canvas ref={canvas} className="mixer-swatch" style={{ width: SWATCH, height: SWATCH }} />;
}

/** The swatch (click: choose the foreground colour and load it) and its menu. */
function LoadControl({ tool, onChange }: { tool: PaintingTool; onChange: () => void }) {
  const controller = useController();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  const state = tool.mixerState;
  const holds =
    state.level <= 0
      ? 'The brush is clean'
      : state.load.kind === 'foreground'
        ? 'The brush is loaded with the foreground colour'
        : 'The brush is loaded with paint from the image';
  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
    onChange();
  };
  return (
    <div className="gradient-picker mixer-load" ref={root}>
      <button
        type="button"
        className="gradient-picker-preview"
        aria-label="Current brush load"
        title={`${holds}. Click to choose a colour to load; Alt-click the image to load paint from it.`}
        onClick={() => void controller.pickMixerColor()}
      >
        <LoadSwatch tool={tool} />
      </button>
      <button
        type="button"
        className="gradient-picker-preview gradient-picker-arrow"
        aria-label="Brush load menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="brush-picker-panel symmetry-panel" role="menu" aria-label="Brush load">
          <button type="button" role="menuitem" className="symmetry-item" onClick={act(() => tool.loadForeground())}>
            <span className="menu-check" />
            Load Brush
          </button>
          <button type="button" role="menuitem" className="symmetry-item" onClick={act(() => tool.cleanBrush())}>
            <span className="menu-check" />
            Clean Brush
          </button>
          <div className="menu-separator" role="separator" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={tool.mixer.solidOnly}
            className="symmetry-item"
            onClick={act(() => tool.setMixer({ solidOnly: !tool.mixer.solidOnly }))}
          >
            <span className="menu-check">{tool.mixer.solidOnly ? '✓' : ''}</span>
            Load Solid Colors Only
          </button>
        </div>
      )}
    </div>
  );
}

export function MixerOptionsBar({ tool }: { tool: PaintingTool }) {
  const controller = useController();
  const bump = useUi((s) => s.bumpToolOptions);
  useUi((s) => s.toolOptionsVersion);
  const brushSettingsOpen = useUi((s) => isPanelOpen(s.dock, 'brush-settings'));
  const o = tool.options;
  const m = tool.mixer;
  const dynamics = o.dynamics ?? DEFAULT_DYNAMICS;
  const buildUp = dynamics.buildUp;
  const percent = (v: number) => Math.round(v * 100);
  const set = (changes: Partial<typeof o>) => {
    tool.setOptions(changes);
    bump();
  };
  const setMixer = (changes: Partial<MixerOptions>) => {
    tool.setMixer(changes);
    bump();
  };
  const toggle = (key: 'loadAfterStroke' | 'cleanAfterStroke', label: string, icon: 'mixerLoad' | 'mixerClean') => (
    <button
      type="button"
      className={`option-icon${m[key] ? ' active' : ''}`}
      aria-pressed={m[key]}
      aria-label={label}
      title={label}
      onClick={() => setMixer({ [key]: !m[key] })}
    >
      <Icon name={icon} size={16} />
    </button>
  );
  const combination = mixerCombination(m);
  return (
    <>
      <BrushPicker tool={tool} />
      <button
        type="button"
        className={`option-icon${brushSettingsOpen ? ' active' : ''}`}
        aria-pressed={brushSettingsOpen}
        aria-label="Toggle the Brush Settings panel"
        title="Toggle the Brush Settings panel (F5)"
        onClick={() => controller.commands.run('window.brushSettings')}
      >
        <Icon name="brushSettings" size={16} />
      </button>
      <span className="options-divider" />
      <LoadControl tool={tool} onChange={bump} />
      {toggle('loadAfterStroke', 'Load the brush after each stroke', 'mixerLoad')}
      {toggle('cleanAfterStroke', 'Clean the brush after each stroke', 'mixerClean')}
      <span className="options-divider" />
      <select
        className="option-select"
        aria-label="Useful mixer brush combinations"
        title="Set Wet, Load and Mix together"
        value={combination}
        onChange={(e) => {
          const c = MIXER_COMBINATIONS.find((x) => x.id === e.target.value);
          if (c) setMixer({ wet: c.wet, load: c.load, mix: c.mix });
        }}
      >
        <option value="custom">Custom</option>
        {MIXER_COMBINATIONS.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <NumberField
        label="Wet:"
        title="How much paint the brush takes up from the canvas"
        value={percent(m.wet)}
        min={0}
        max={100}
        suffix="%"
        width={46}
        onChange={(v) => setMixer({ wet: v / 100 })}
      />
      <NumberField
        label="Load:"
        title="How much paint the reservoir holds: with little, strokes run dry sooner"
        value={percent(m.load)}
        min={1}
        max={100}
        suffix="%"
        width={46}
        onChange={(v) => setMixer({ load: v / 100 })}
      />
      <NumberField
        label="Mix:"
        title="The share of canvas paint in the paint laid down (needs Wet above 0 %)"
        value={m.wet > 0 ? percent(m.mix) : 0}
        min={0}
        max={100}
        suffix="%"
        width={46}
        disabled={m.wet <= 0}
        onChange={(v) => setMixer({ mix: v / 100 })}
      />
      <NumberField
        label="Flow:"
        value={percent(o.flow)}
        min={1}
        max={100}
        suffix="%"
        width={46}
        onChange={(v) => set({ flow: v / 100 })}
      />
      <button
        type="button"
        className={`option-icon${buildUp ? ' active' : ''}`}
        aria-pressed={buildUp}
        aria-label="Airbrush-style build-up"
        title="Airbrush-style build-up: paint keeps flowing while the pointer rests"
        onClick={() => set({ dynamics: { ...dynamics, buildUp: !buildUp } })}
      >
        <Icon name="airbrush" size={16} />
      </button>
      <SmoothingControls tool={tool} />
      <span className="options-divider" />
      <NumberField
        label={
          <span className="option-icon-label" title="Brush angle (drag to change)">
            <Icon name="angle" size={16} />
          </span>
        }
        ariaLabel="Brush angle"
        value={o.angle}
        min={-180}
        max={180}
        suffix="°"
        width={46}
        onChange={(angle) => set({ angle })}
      />
      <label className="option-check" title="Take up the paint all visible layers show, not only the active layer's">
        <input
          type="checkbox"
          checked={m.sampleAllLayers}
          onChange={(e) => setMixer({ sampleAllLayers: e.target.checked })}
        />
        Sample All Layers
      </label>
      <button
        type="button"
        className={`option-icon${o.pressureSize ? ' active' : ''}`}
        aria-pressed={o.pressureSize}
        aria-label="Pen pressure controls size"
        title="Pen pressure controls size"
        onClick={() => set({ pressureSize: !o.pressureSize })}
      >
        <Icon name="penPressureSize" size={16} />
      </button>
      <span className="options-divider" />
      <SymmetryMenu />
    </>
  );
}
