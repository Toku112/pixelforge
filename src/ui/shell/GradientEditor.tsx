/**
 * The Gradient Editor (click the gradient in the Gradient tool's options bar).
 *
 * Behaviour (own summary of the reference app):
 * - Presets at the top load into the editor; New adds the edited gradient to them
 *   under the name typed.
 * - Solid gradients: opacity stops above the bar, colour stops below. Click beside
 *   the bar to add a stop, drag a stop to move it (Alt-drag copies it), drag it away
 *   from the bar to remove it (at least two stay). The diamonds next to the selected
 *   stop are the midpoints. Double-click a colour stop to pick its colour; a stop can
 *   also follow the foreground or background colour. Smoothness rounds off the
 *   transitions.
 * - Noise gradients: roughness, the colour model with a range per channel, Restrict
 *   Colors, Add Transparency and Randomize.
 * - Holding Alt turns Cancel into Reset.
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { rgbToHex, type RGB } from '../../core/color/color';
import {
  FOREGROUND_TO_BACKGROUND,
  cloneGradient,
  gradientTable,
  noiseGradient,
  resolveGradient,
  type ColorStop,
  type Gradient,
  type NoiseGradient,
  type NoiseModel,
  type OpacityStop,
  type SolidGradient,
} from '../../core/paint/gradient';
import { useController } from '../AppContext';
import { NumberField } from '../controls/NumberField';
import { useAltKey } from '../controls/use-alt-key';
import { GradientStrip } from '../GradientStrip';
import { GradientList } from '../panels/GradientList';
import { useUi, type DialogRequest } from '../state/ui-store';
import { Modal } from './Modal';

/** Width of the gradient bar, CSS pixels. */
const BAR = 360;
/** Dragging a stop this far (CSS px) from its row removes it. */
const TEAR_OFF = 28;

type Selected = { kind: 'color' | 'opacity'; index: number } | null;

const CHANNELS: Record<NoiseModel, [string, string, string]> = {
  rgb: ['R', 'G', 'B'],
  hsb: ['H', 'S', 'B'],
  lab: ['L', 'a', 'b'],
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const pct = (v: number) => Math.round(v * 1000) / 10;
const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

/** Stops of one kind in location order, with their index in the gradient's list. */
function sorted<S extends { location: number }>(stops: readonly S[]): { stop: S; index: number }[] {
  return stops.map((stop, index) => ({ stop, index })).sort((a, b) => a.stop.location - b.stop.location);
}

export function GradientEditorDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'gradient-editor' }> }) {
  const controller = useController();
  const close = useUi((s) => s.closeDialog);
  const pushDialog = useUi((s) => s.pushDialog);
  const alt = useAltKey();
  const [g, setG] = useState<Gradient>(() => cloneGradient(dialog.gradient));
  const [presetId, setPresetId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected>(g.type === 'solid' ? { kind: 'color', index: 0 } : null);
  // The other type's last state, so switching Solid ↔ Noise and back loses nothing.
  const other = useRef<Gradient | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: 'color' | 'opacity'; index: number; y: number; removing: boolean } | null>(null);
  const [removing, setRemoving] = useState(false);
  const midDrag = useRef<{ kind: 'color' | 'opacity'; index: number; from: number; to: number } | null>(null);
  const fg = controller.colors.foreground;
  const bg = controller.colors.background;

  const cancel = () => (close(dialog), dialog.resolve(null));
  const ok = () => (close(dialog), dialog.resolve(g));
  const reset = () => {
    setG(cloneGradient(dialog.gradient));
    setPresetId(null);
    setSelected(dialog.gradient.type === 'solid' ? { kind: 'color', index: 0 } : null);
  };

  const edit = (next: Gradient) => {
    setG(next);
    setPresetId(null);
  };
  const editSolid = (fn: (s: SolidGradient) => SolidGradient) => {
    if (g.type === 'solid') edit(fn(g));
  };
  const editNoise = (changes: Partial<NoiseGradient>) => {
    if (g.type === 'noise') edit({ ...g, ...changes });
  };

  const setType = (type: 'solid' | 'noise') => {
    if (type === g.type) return;
    const next =
      other.current?.type === type
        ? other.current
        : type === 'noise'
          ? noiseGradient(g.name, randomSeed())
          : { ...cloneGradient(FOREGROUND_TO_BACKGROUND), name: g.name };
    other.current = g;
    edit({ ...next, name: g.name });
    setSelected(type === 'solid' ? { kind: 'color', index: 0 } : null);
  };

  // -- the stop bar -----------------------------------------------------------

  const locationAt = (clientX: number) => {
    const box = bar.current?.getBoundingClientRect();
    return box ? clamp01((clientX - box.left) / box.width) : 0;
  };

  /** The colour (and opacity) the gradient has at a location, for a new stop there. */
  const valueAt = (location: number): { color: RGB; opacity: number } => {
    const table = gradientTable(resolveGradient(g, fg, bg), dialog.method, true, 1001);
    const i = Math.round(location * 1000) * 4;
    return { color: { r: table[i]!, g: table[i + 1]!, b: table[i + 2]! }, opacity: table[i + 3]! };
  };

  const stopsOf = (s: SolidGradient, kind: 'color' | 'opacity') => (kind === 'color' ? s.colorStops : s.opacityStops);
  const withStops = (s: SolidGradient, kind: 'color' | 'opacity', stops: (ColorStop | OpacityStop)[]): SolidGradient =>
    kind === 'color' ? { ...s, colorStops: stops as ColorStop[] } : { ...s, opacityStops: stops as OpacityStop[] };

  const moveStop = (kind: 'color' | 'opacity', index: number, location: number) =>
    editSolid((s) =>
      withStops(
        s,
        kind,
        stopsOf(s, kind).map((x, i) => (i === index ? { ...x, location: clamp01(location) } : x)),
      ),
    );

  const removeStop = (kind: 'color' | 'opacity', index: number) => {
    if (g.type !== 'solid' || stopsOf(g, kind).length <= 2) return;
    editSolid((s) =>
      withStops(
        s,
        kind,
        stopsOf(s, kind).filter((_, i) => i !== index),
      ),
    );
    setSelected({ kind, index: 0 });
  };

  const addStop = (kind: 'color' | 'opacity', location: number) => {
    if (g.type !== 'solid') return;
    const v = valueAt(location);
    const stop: ColorStop | OpacityStop =
      kind === 'color'
        ? { location, midpoint: 0.5, color: v.color, kind: 'color' }
        : { location, midpoint: 0.5, opacity: v.opacity };
    const stops = [...stopsOf(g, kind), stop];
    edit(withStops(g, kind, stops));
    setSelected({ kind, index: stops.length - 1 });
  };

  const pickColor = (index: number) => {
    if (g.type !== 'solid') return;
    const stop = g.colorStops[index];
    if (!stop) return;
    const current = stop.kind === 'foreground' ? fg : stop.kind === 'background' ? bg : stop.color;
    pushDialog({
      kind: 'color-picker',
      title: 'Color Picker (Stop Color)',
      color: current,
      resolve: (color) => {
        if (!color) return;
        setG((now) =>
          now.type === 'solid'
            ? {
                ...now,
                colorStops: now.colorStops.map((x, i) => (i === index ? { ...x, color, kind: 'color' } : x)),
              }
            : now,
        );
        setPresetId(null);
      },
    });
  };

  const onStopDown = (e: PointerEvent<HTMLButtonElement>, kind: 'color' | 'opacity', index: number) => {
    e.stopPropagation();
    if (g.type !== 'solid') return;
    let i = index;
    if (e.altKey) {
      // Alt-drag copies the stop.
      const stops = [...stopsOf(g, kind), { ...stopsOf(g, kind)[index]! }];
      edit(withStops(g, kind, stops));
      i = stops.length - 1;
    }
    setSelected({ kind, index: i });
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind, index: i, y: e.clientY, removing: false };
  };

  const onStopMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || g.type !== 'solid') return;
    const away = Math.abs(e.clientY - d.y) > TEAR_OFF && stopsOf(g, d.kind).length > 2;
    if (away !== d.removing) {
      d.removing = away;
      setRemoving(away);
    }
    if (!away) moveStop(d.kind, d.index, locationAt(e.clientX));
  };

  const onStopUp = () => {
    const d = drag.current;
    drag.current = null;
    setRemoving(false);
    if (d?.removing) removeStop(d.kind, d.index);
  };

  const onStopKey = (e: KeyboardEvent<HTMLButtonElement>, kind: 'color' | 'opacity', index: number) => {
    if (g.type !== 'solid') return;
    const stop = stopsOf(g, kind)[index];
    if (!stop) return;
    const step = (e.shiftKey ? 10 : 1) / 100;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      moveStop(kind, index, stop.location + (e.key === 'ArrowLeft' ? -step : step));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeStop(kind, index);
    } else if (e.key === 'Enter' && kind === 'color') {
      e.preventDefault();
      pickColor(index);
    }
  };

  /** The midpoints beside the selected stop: [left stop index, from, to, midpoint]. */
  const midpoints = (): { index: number; from: number; to: number; midpoint: number }[] => {
    if (g.type !== 'solid' || !selected) return [];
    const order = sorted(stopsOf(g, selected.kind) as (ColorStop | OpacityStop)[]);
    const at = order.findIndex((o) => o.index === selected.index);
    if (at < 0) return [];
    const out = [];
    for (const k of [at - 1, at]) {
      const a = order[k];
      const b = order[k + 1];
      if (a && b && b.stop.location > a.stop.location)
        out.push({ index: a.index, from: a.stop.location, to: b.stop.location, midpoint: a.stop.midpoint });
    }
    return out;
  };

  const setMidpoint = (kind: 'color' | 'opacity', index: number, midpoint: number) =>
    editSolid((s) =>
      withStops(
        s,
        kind,
        stopsOf(s, kind).map((x, i) =>
          i === index ? { ...x, midpoint: Math.min(0.95, Math.max(0.05, midpoint)) } : x,
        ),
      ),
    );

  const row = (kind: 'color' | 'opacity') => {
    if (g.type !== 'solid') return null;
    const stops = stopsOf(g, kind) as (ColorStop | OpacityStop)[];
    const mids = selected?.kind === kind ? midpoints() : [];
    return (
      <div
        className={`gradient-stop-row ${kind}`}
        aria-label={kind === 'color' ? 'Color stops (click to add)' : 'Opacity stops (click to add)'}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) addStop(kind, locationAt(e.clientX));
        }}
      >
        {stops.map((stop, index) => {
          const isSel = selected?.kind === kind && selected.index === index;
          const fill =
            kind === 'color'
              ? `#${rgbToHex((stop as ColorStop).kind === 'foreground' ? fg : (stop as ColorStop).kind === 'background' ? bg : (stop as ColorStop).color)}`
              : `rgb(${Math.round((1 - (stop as OpacityStop).opacity) * 255)} ${Math.round((1 - (stop as OpacityStop).opacity) * 255)} ${Math.round((1 - (stop as OpacityStop).opacity) * 255)})`;
          return (
            <button
              key={index}
              type="button"
              className={`gradient-stop${isSel ? ' selected' : ''}${isSel && removing ? ' removing' : ''}`}
              style={{ left: stop.location * BAR }}
              aria-label={`${kind === 'color' ? 'Color' : 'Opacity'} stop at ${pct(stop.location)}%`}
              aria-pressed={isSel}
              onPointerDown={(e) => onStopDown(e, kind, index)}
              onPointerMove={onStopMove}
              onPointerUp={onStopUp}
              onPointerCancel={onStopUp}
              onFocus={() => setSelected({ kind, index })}
              onKeyDown={(e) => onStopKey(e, kind, index)}
              onDoubleClick={() => kind === 'color' && pickColor(index)}
            >
              <span className="gradient-stop-fill" style={{ background: fill }} />
            </button>
          );
        })}
        {mids.map((m) => (
          <span
            key={`mid-${m.index}`}
            className="gradient-midpoint"
            role="slider"
            tabIndex={0}
            aria-label="Midpoint"
            aria-valuemin={5}
            aria-valuemax={95}
            aria-valuenow={Math.round(m.midpoint * 100)}
            style={{ left: (m.from + (m.to - m.from) * m.midpoint) * BAR }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              midDrag.current = { kind, index: m.index, from: m.from, to: m.to };
            }}
            onPointerMove={(e) => {
              const d = midDrag.current;
              if (d) setMidpoint(d.kind, d.index, (locationAt(e.clientX) - d.from) / (d.to - d.from));
            }}
            onPointerUp={() => (midDrag.current = null)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
              e.preventDefault();
              const step = (e.shiftKey ? 10 : 1) / 100;
              setMidpoint(kind, m.index, m.midpoint + (e.key === 'ArrowLeft' ? -step : step));
            }}
          />
        ))}
      </div>
    );
  };

  // -- the fields --------------------------------------------------------------

  const solidFields = () => {
    if (g.type !== 'solid') return null;
    const sel = selected;
    const colorStop = sel?.kind === 'color' ? g.colorStops[sel.index] : undefined;
    const opacityStop = sel?.kind === 'opacity' ? g.opacityStops[sel.index] : undefined;
    const stop = colorStop ?? opacityStop;
    const midpoint = sel && stop ? stop.midpoint : 0.5;
    const swatch = colorStop
      ? colorStop.kind === 'foreground'
        ? fg
        : colorStop.kind === 'background'
          ? bg
          : colorStop.color
      : null;
    return (
      <>
        <NumberField
          label="Smoothness:"
          value={Math.round(g.smoothness * 100)}
          min={0}
          max={100}
          suffix="%"
          width={52}
          onChange={(v) => editSolid((s) => ({ ...s, smoothness: v / 100 }))}
        />
        <div className="gradient-bar-area">
          {row('opacity')}
          <div className="gradient-bar" ref={bar} style={{ width: BAR }}>
            <GradientStrip gradient={g} method={dialog.method} width={BAR} height={28} />
          </div>
          {row('color')}
        </div>
        <fieldset className="dialog-fieldset gradient-stop-fields">
          <legend>Stops</legend>
          <div className="gradient-field-row">
            <NumberField
              label="Opacity:"
              value={opacityStop ? Math.round(opacityStop.opacity * 100) : 100}
              min={0}
              max={100}
              suffix="%"
              width={52}
              disabled={!opacityStop}
              onChange={(v) =>
                sel &&
                editSolid((s) => ({
                  ...s,
                  opacityStops: s.opacityStops.map((x, i) => (i === sel.index ? { ...x, opacity: v / 100 } : x)),
                }))
              }
            />
            <label className="option-field">
              Color:
              <button
                type="button"
                className="gradient-color-button"
                aria-label="Stop color"
                disabled={!colorStop}
                style={{ background: swatch ? `#${rgbToHex(swatch)}` : undefined }}
                onClick={() => sel && pickColor(sel.index)}
              />
            </label>
            <select
              className="option-select"
              aria-label="Stop color type"
              disabled={!colorStop}
              value={colorStop?.kind ?? 'color'}
              onChange={(e) =>
                sel &&
                editSolid((s) => ({
                  ...s,
                  colorStops: s.colorStops.map((x, i) =>
                    i === sel.index
                      ? {
                          ...x,
                          kind: e.target.value as ColorStop['kind'],
                          // Keep the colour shown when it stops following the swatches.
                          color: x.kind === 'foreground' ? { ...fg } : x.kind === 'background' ? { ...bg } : x.color,
                        }
                      : x,
                  ),
                }))
              }
            >
              <option value="color">User Color</option>
              <option value="foreground">Foreground</option>
              <option value="background">Background</option>
            </select>
          </div>
          <div className="gradient-field-row">
            <NumberField
              label="Location:"
              value={stop ? pct(stop.location) : 0}
              min={0}
              max={100}
              precision={1}
              suffix="%"
              width={58}
              disabled={!stop}
              onChange={(v) => sel && moveStop(sel.kind, sel.index, v / 100)}
            />
            <NumberField
              label="Midpoint:"
              value={Math.round(midpoint * 100)}
              min={5}
              max={95}
              suffix="%"
              width={52}
              disabled={!stop}
              onChange={(v) => sel && setMidpoint(sel.kind, sel.index, v / 100)}
            />
            <button
              type="button"
              disabled={!sel || stopsOf(g, sel.kind).length <= 2}
              onClick={() => sel && removeStop(sel.kind, sel.index)}
            >
              Delete
            </button>
          </div>
        </fieldset>
      </>
    );
  };

  const noiseFields = () => {
    if (g.type !== 'noise') return null;
    const names = CHANNELS[g.model];
    const range = (which: 'min' | 'max', c: number, v: number) => {
      const next = [...g[which]] as [number, number, number];
      next[c] = clamp01(v / 100);
      editNoise({ [which]: next });
    };
    return (
      <>
        <NumberField
          label="Roughness:"
          value={Math.round(g.roughness * 100)}
          min={0}
          max={100}
          suffix="%"
          width={52}
          onChange={(v) => editNoise({ roughness: v / 100 })}
        />
        <div className="gradient-bar" style={{ width: BAR }}>
          <GradientStrip gradient={g} method={dialog.method} width={BAR} height={28} />
        </div>
        <label className="option-field">
          Color Model:
          <select
            className="option-select"
            aria-label="Color model"
            value={g.model}
            onChange={(e) => editNoise({ model: e.target.value as NoiseModel })}
          >
            <option value="rgb">RGB</option>
            <option value="hsb">HSB</option>
            <option value="lab">LAB</option>
          </select>
        </label>
        {names.map((name, c) => (
          <div key={name} className="gradient-field-row">
            <span className="gradient-channel">{name}</span>
            <NumberField
              label="Min:"
              ariaLabel={`${name} minimum`}
              value={Math.round(g.min[c]! * 100)}
              min={0}
              max={100}
              suffix="%"
              width={52}
              onChange={(v) => range('min', c, v)}
            />
            <NumberField
              label="Max:"
              ariaLabel={`${name} maximum`}
              value={Math.round(g.max[c]! * 100)}
              min={0}
              max={100}
              suffix="%"
              width={52}
              onChange={(v) => range('max', c, v)}
            />
          </div>
        ))}
        <div className="gradient-field-row">
          <label className="option-check">
            <input
              type="checkbox"
              checked={g.restrictColors}
              onChange={(e) => editNoise({ restrictColors: e.target.checked })}
            />
            Restrict Colors
          </label>
          <label className="option-check">
            <input
              type="checkbox"
              checked={g.addTransparency}
              onChange={(e) => editNoise({ addTransparency: e.target.checked })}
            />
            Add Transparency
          </label>
          <button type="button" onClick={() => editNoise({ seed: randomSeed() })}>
            Randomize
          </button>
        </div>
      </>
    );
  };

  return (
    <Modal title="Gradient Editor" onCancel={cancel} className="gradient-editor">
      <div className="dialog-form">
        <div className="gradient-editor-presets" aria-label="Presets">
          <GradientList
            selectedId={presetId}
            onPick={(id) => {
              const entry = controller.services.gradients.find(id);
              if (!entry) return;
              setG(cloneGradient(entry.gradient));
              setPresetId(id);
              setSelected(entry.gradient.type === 'solid' ? { kind: 'color', index: 0 } : null);
            }}
          />
        </div>
        <div className="gradient-field-row">
          <label className="option-field">
            Name:
            <input
              type="text"
              className="option-text"
              aria-label="Gradient name"
              value={g.name}
              onChange={(e) => setG({ ...g, name: e.target.value })}
            />
          </label>
          <button
            type="button"
            title="Add this gradient to the presets"
            onClick={() => void controller.addGradientPreset(cloneGradient(g)).then(setPresetId)}
          >
            New
          </button>
        </div>
        <label className="option-field">
          Gradient Type:
          <select
            className="option-select"
            aria-label="Gradient type"
            value={g.type}
            onChange={(e) => setType(e.target.value as 'solid' | 'noise')}
          >
            <option value="solid">Solid</option>
            <option value="noise">Noise</option>
          </select>
        </label>
        {solidFields()}
        {noiseFields()}
        <div className="modal-buttons">
          <button type="button" className="primary-button" data-autofocus onClick={ok}>
            OK
          </button>
          <button type="button" onClick={alt ? reset : cancel}>
            {alt ? 'Reset' : 'Cancel'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
