/**
 * The Gradient tool's options bar: the gradient (click it to edit; the arrow opens
 * the presets), the five shapes, Mode, Opacity, Reverse, Dither, Transparency and
 * Method.
 */
import { useEffect, useRef, useState } from 'react';
import { BLEND_MODE_LABELS, brushModeMenu } from '../../core/composite/blend';
import { GRADIENT_METHODS, GRADIENT_SHAPES, type GradientShape } from '../../core/paint/gradient';
import type { GradientOptions, GradientTool } from '../../tools/gradient/gradient-tool';
import { useController } from '../AppContext';
import { NumberField } from '../controls/NumberField';
import { GradientStrip } from '../GradientStrip';
import { Icon, type IconName } from '../icons';
import { GradientList } from '../panels/GradientList';
import { useUi } from '../state/ui-store';

const SHAPE_ICONS: Record<GradientShape, IconName> = {
  linear: 'gradientLinear',
  radial: 'gradientRadial',
  angle: 'gradientAngle',
  reflected: 'gradientReflected',
  diamond: 'gradientDiamond',
};

/** The gradient preview (opens the Gradient Editor) and the presets popup. */
function GradientPicker({ tool }: { tool: GradientTool }) {
  const controller = useController();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!root.current?.contains(target) && !target?.closest('.modal-backdrop')) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) setOpen(false);
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="gradient-picker" ref={root}>
      <button
        type="button"
        className="gradient-picker-preview"
        aria-label="Edit the gradient"
        title={`${tool.options.gradient.name} — click to edit`}
        onClick={() => void controller.editGradient()}
      >
        <GradientStrip gradient={tool.options.gradient} method={tool.options.method} width={110} height={18} />
      </button>
      <button
        type="button"
        className="gradient-picker-arrow"
        aria-label="Gradient presets"
        aria-expanded={open}
        title="Gradient presets"
        onClick={() => setOpen(!open)}
      >
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="brush-picker-panel gradient-picker-panel" role="group" aria-label="Gradient presets">
          <GradientList onChoose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

export function GradientOptionsBar({ tool }: { tool: GradientTool }) {
  const controller = useController();
  const bump = useUi((s) => s.bumpToolOptions);
  useUi((s) => s.toolOptionsVersion);
  const o = tool.options;
  const set = (changes: Partial<GradientOptions>) => {
    tool.setOptions(changes);
    bump();
  };
  const doc = controller.workspace.active?.doc;
  const layer = doc?.activeLayer;
  // Behind and Clear need transparency that may change (not the Background or locked transparency).
  const alphaEditable = layer?.kind === 'pixel' && layer.buffer.format.hasAlpha && !layer.locks.transparency;
  return (
    <>
      <GradientPicker tool={tool} />
      <div className="segmented" role="radiogroup" aria-label="Gradient shape">
        {GRADIENT_SHAPES.map(([shape, label]) => (
          <button
            key={shape}
            type="button"
            role="radio"
            aria-checked={o.shape === shape}
            aria-label={label}
            title={label}
            className={`option-icon${o.shape === shape ? ' active' : ''}`}
            onClick={() => set({ shape })}
          >
            <Icon name={SHAPE_ICONS[shape]} size={16} />
          </button>
        ))}
      </div>
      <span className="options-divider" />
      <label className="option-field">
        Mode:
        <select
          className="option-select"
          aria-label="Gradient mode"
          value={o.mode}
          onChange={(e) => set({ mode: e.target.value as GradientOptions['mode'] })}
        >
          {brushModeMenu(doc?.mode ?? 'rgb', doc?.depth ?? 8).map((m) => (
            <option key={m} value={m} disabled={(m === 'behind' || m === 'clear') && !alphaEditable}>
              {m === 'behind' ? 'Behind' : m === 'clear' ? 'Clear' : BLEND_MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      <NumberField
        label="Opacity:"
        value={Math.round(o.opacity * 100)}
        min={1}
        max={100}
        suffix="%"
        width={46}
        onChange={(v) => set({ opacity: v / 100 })}
      />
      <span className="options-divider" />
      <label className="option-check">
        <input type="checkbox" checked={o.reverse} onChange={(e) => set({ reverse: e.target.checked })} />
        Reverse
      </label>
      <label className="option-check">
        <input type="checkbox" checked={o.dither} onChange={(e) => set({ dither: e.target.checked })} />
        Dither
      </label>
      <label className="option-check">
        <input type="checkbox" checked={o.transparency} onChange={(e) => set({ transparency: e.target.checked })} />
        Transparency
      </label>
      <label className="option-field">
        Method:
        <select
          className="option-select"
          aria-label="Gradient method"
          value={o.method}
          onChange={(e) => set({ method: e.target.value as GradientOptions['method'] })}
        >
          {GRADIENT_METHODS.map(([m, label]) => (
            <option key={m} value={m}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
