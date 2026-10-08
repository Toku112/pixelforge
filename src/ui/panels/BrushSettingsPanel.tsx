/**
 * Brush Settings panel (Window > Brush Settings, F5): the active painting tool's
 * brush — tip shape and the dynamics sections, each switched on by its checkbox —
 * with a preview stroke at the bottom (painted in the worker).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { colorToSamples } from '../../core/color/color';
import { strokePoint } from '../../core/paint/brush';
import {
  DEFAULT_DYNAMICS,
  StrokeDabber,
  type BrushDynamics,
  type ControlledJitter,
  type DynamicsControl,
} from '../../core/paint/dynamics';
import { PaintingTool } from '../../tools/paint/paint-tool';
import { useController } from '../AppContext';
import { NumberField } from '../controls/NumberField';
import { TipThumbnail } from '../shell/BrushPicker';
import { useUi } from '../state/ui-store';

type Section = 'tip' | 'shape' | 'scatter' | 'color' | 'transfer' | 'pose';

const SECTIONS: [Section, string][] = [
  ['tip', 'Brush Tip Shape'],
  ['shape', 'Shape Dynamics'],
  ['scatter', 'Scattering'],
  ['color', 'Color Dynamics'],
  ['transfer', 'Transfer'],
  ['pose', 'Brush Pose'],
];

const CONTROL_LABELS: Record<DynamicsControl, string> = {
  off: 'Off',
  fade: 'Fade',
  pressure: 'Pen Pressure',
  tilt: 'Pen Tilt',
  wheel: 'Stylus Wheel',
  rotation: 'Rotation',
  'initial-direction': 'Initial Direction',
  direction: 'Direction',
};
const BASIC: DynamicsControl[] = ['off', 'fade', 'pressure', 'tilt', 'wheel'];
const ANGLE: DynamicsControl[] = [...BASIC, 'rotation', 'initial-direction', 'direction'];
const ROUNDNESS: DynamicsControl[] = [...BASIC, 'rotation'];

const pct = (v: number) => Math.round(v * 100);

function ControlSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: DynamicsControl;
  options: DynamicsControl[];
  onChange: (c: DynamicsControl) => void;
}) {
  return (
    <label className="brush-row">
      <span>Control</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as DynamicsControl)}>
        {options.map((c) => (
          <option key={c} value={c}>
            {CONTROL_LABELS[c]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A jitter with its control, fade length and (optional) minimum. */
function JitterRows({
  label,
  value,
  controls,
  minimum,
  onChange,
}: {
  label: string;
  value: ControlledJitter;
  controls: DynamicsControl[];
  minimum?: string;
  onChange: (v: ControlledJitter) => void;
}) {
  const set = (changes: Partial<ControlledJitter>) => onChange({ ...value, ...changes });
  return (
    <div className="brush-group">
      <NumberField
        label={label}
        value={pct(value.jitter)}
        min={0}
        max={100}
        suffix="%"
        width={52}
        onChange={(v) => set({ jitter: v / 100 })}
      />
      <ControlSelect
        label={`${label} control`}
        value={value.control}
        options={controls}
        onChange={(c) => set({ control: c })}
      />
      {value.control === 'fade' && (
        <NumberField
          label="Fade steps"
          ariaLabel={`${label} fade steps`}
          value={value.fadeSteps}
          min={1}
          max={9999}
          width={52}
          onChange={(v) => set({ fadeSteps: v })}
        />
      )}
      {minimum && (
        <NumberField
          label={minimum}
          value={pct(value.minimum)}
          min={0}
          max={100}
          suffix="%"
          width={52}
          onChange={(v) => set({ minimum: v / 100 })}
        />
      )}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="option-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function BrushSettingsPanel() {
  const controller = useController();
  const toolId = useUi((s) => s.activeToolId);
  useUi((s) => s.toolOptionsVersion);
  const bump = useUi((s) => s.bumpToolOptions);
  const [section, setSection] = useState<Section>('tip');
  const preview = useRef<HTMLCanvasElement>(null);
  const tool = controller.tools.byId.get(toolId);
  const painting = tool instanceof PaintingTool ? tool : null;
  const o = painting?.options;
  const dyn = o?.dynamics ?? DEFAULT_DYNAMICS;

  const set = (changes: Partial<NonNullable<typeof o>>) => {
    painting?.setOptions(changes);
    bump();
  };
  const setDyn = <K extends keyof BrushDynamics>(key: K, changes: Partial<BrushDynamics[K]>) =>
    set({ dynamics: { ...dyn, [key]: { ...dyn[key], ...changes } } });

  // The preview stroke: an S-curve, pressure rising and falling, painted in the worker.
  const version = useUi((s) => s.toolOptionsVersion);
  const colorVersion = useSyncExternalStore(
    (onChange) => controller.colors.changes.on(onChange),
    () => controller.colors.version,
  );
  useEffect(() => {
    const canvas = preview.current;
    if (!canvas || !o) return;
    let current = true;
    const width = 240;
    const height = 70;
    const brush = { ...o, size: Math.min(o.size, 40) };
    const colors = {
      foreground: controller.colors.foreground,
      background: controller.colors.background,
      toSamples: (c: { r: number; g: number; b: number }) => colorToSamples(c, 'rgb', 8),
    };
    // Colour dynamics are for the Brush only (the Eraser has no colour to vary).
    const varyColor = painting.kind === 'brush' && dyn.color.enabled;
    const dabber = new StrokeDabber(brush, 12345, varyColor ? colors : null);
    const dabs = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const p = strokePoint(
        20 + t * (width - 40),
        height / 2 - Math.sin(t * Math.PI * 2) * (height / 2 - 18),
        Math.sin(t * Math.PI),
      );
      dabs.push(...dabber.add(p));
    }
    const tip = o.tip ? (controller.services.brushes.get(o.tip) ?? null) : null;
    const setup = {
      format: { depth: 8 as const, colorChannels: 3, hasAlpha: true },
      color: colorToSamples(painting.kind === 'brush' ? controller.colors.foreground : { r: 0, g: 0, b: 0 }, 'rgb', 8),
      erase: false,
      opacity: o.opacity,
      flow: o.flow,
      hardness: o.hardness,
      mode: 'normal' as const,
      tip: tip ? { width: tip.width, height: tip.height, data: tip.data } : null,
      varyColor,
      varyOpacity: dyn.transfer.enabled,
      lockAlpha: false,
      offsetX: 0,
      offsetY: 0,
      selection: null,
    };
    void controller.services.brushPreview(setup, dabs, width, height).then((rgba) => {
      if (!current) return;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx?.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- redraw on any option or colour change
  }, [version, colorVersion, toolId]);

  if (!painting || !o) return <p className="panel-empty">Choose the Brush or Eraser to set its brush here.</p>;

  const enabled = (s: Section) => s !== 'tip' && dyn[s].enabled;
  const body: Record<Section, ReactNode> = {
    tip: (
      <>
        <div className="brush-tips" role="listbox" aria-label="Brush tips">
          <button
            type="button"
            role="option"
            aria-selected={o.tip === null}
            aria-label="Round"
            className="brush-tip"
            onClick={() => set({ tip: null })}
          >
            <TipThumbnail tip={null} box={32} roundHardness={o.hardness} />
          </button>
          {controller.services.brushes.list().map((t) => (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={o.tip === t.id}
              aria-label={t.name}
              className="brush-tip"
              onClick={() => set({ tip: t.id, size: Math.max(t.width, t.height) })}
            >
              <TipThumbnail tip={t} box={32} />
            </button>
          ))}
        </div>
        <div className="brush-group">
          <NumberField
            label="Size"
            value={o.size}
            min={1}
            max={5000}
            suffix=" px"
            width={64}
            onChange={(size) => set({ size })}
          />
          <Check label="Flip X" checked={o.flipX} onChange={(flipX) => set({ flipX })} />
          <Check label="Flip Y" checked={o.flipY} onChange={(flipY) => set({ flipY })} />
          <NumberField
            label="Angle"
            value={o.angle}
            min={-180}
            max={180}
            suffix="°"
            width={52}
            onChange={(angle) => set({ angle })}
          />
          <NumberField
            label="Roundness"
            value={pct(o.roundness)}
            min={1}
            max={100}
            suffix="%"
            width={52}
            onChange={(v) => set({ roundness: v / 100 })}
          />
          <NumberField
            label="Hardness"
            value={pct(o.hardness)}
            min={0}
            max={100}
            suffix="%"
            width={52}
            disabled={o.tip !== null}
            onChange={(v) => set({ hardness: v / 100 })}
          />
          <NumberField
            label="Spacing"
            value={pct(o.spacing)}
            min={1}
            max={1000}
            suffix="%"
            width={52}
            onChange={(v) => set({ spacing: v / 100 })}
          />
        </div>
      </>
    ),
    shape: (
      <>
        <JitterRows
          label="Size Jitter"
          value={dyn.shape.size}
          controls={BASIC}
          minimum="Minimum Diameter"
          onChange={(size) => setDyn('shape', { size })}
        />
        <NumberField
          label="Tilt Scale"
          value={pct(dyn.shape.tiltScale)}
          min={0}
          max={200}
          suffix="%"
          width={52}
          disabled={dyn.shape.size.control !== 'tilt'}
          onChange={(v) => setDyn('shape', { tiltScale: v / 100 })}
        />
        <JitterRows
          label="Angle Jitter"
          value={dyn.shape.angle}
          controls={ANGLE}
          onChange={(angle) => setDyn('shape', { angle })}
        />
        <JitterRows
          label="Roundness Jitter"
          value={dyn.shape.roundness}
          controls={ROUNDNESS}
          minimum="Minimum Roundness"
          onChange={(roundness) => setDyn('shape', { roundness })}
        />
        <Check
          label="Flip X Jitter"
          checked={dyn.shape.flipXJitter}
          onChange={(flipXJitter) => setDyn('shape', { flipXJitter })}
        />
        <Check
          label="Flip Y Jitter"
          checked={dyn.shape.flipYJitter}
          onChange={(flipYJitter) => setDyn('shape', { flipYJitter })}
        />
      </>
    ),
    scatter: (
      <>
        <div className="brush-group">
          <NumberField
            label="Scatter"
            value={pct(dyn.scatter.amount)}
            min={0}
            max={1000}
            suffix="%"
            width={56}
            onChange={(v) => setDyn('scatter', { amount: v / 100 })}
          />
          <Check
            label="Both Axes"
            checked={dyn.scatter.bothAxes}
            onChange={(bothAxes) => setDyn('scatter', { bothAxes })}
          />
          <ControlSelect
            label="Scatter control"
            value={dyn.scatter.control}
            options={BASIC}
            onChange={(control) => setDyn('scatter', { control })}
          />
        </div>
        <NumberField
          label="Count"
          value={dyn.scatter.count}
          min={1}
          max={16}
          width={44}
          onChange={(count) => setDyn('scatter', { count })}
        />
        <JitterRows
          label="Count Jitter"
          value={dyn.scatter.countJitter}
          controls={BASIC}
          onChange={(countJitter) => setDyn('scatter', { countJitter })}
        />
      </>
    ),
    color: (
      <>
        <Check label="Apply Per Tip" checked={dyn.color.perTip} onChange={(perTip) => setDyn('color', { perTip })} />
        <JitterRows
          label="Foreground/Background Jitter"
          value={dyn.color.fgbg}
          controls={BASIC}
          onChange={(fgbg) => setDyn('color', { fgbg })}
        />
        <div className="brush-group">
          {(['hue', 'saturation', 'brightness'] as const).map((k) => (
            <NumberField
              key={k}
              label={`${k[0]!.toUpperCase()}${k.slice(1)} Jitter`}
              value={pct(dyn.color[k])}
              min={0}
              max={100}
              suffix="%"
              width={52}
              onChange={(v) => setDyn('color', { [k]: v / 100 })}
            />
          ))}
          <NumberField
            label="Purity"
            value={pct(dyn.color.purity)}
            min={-100}
            max={100}
            suffix="%"
            width={52}
            onChange={(v) => setDyn('color', { purity: v / 100 })}
          />
        </div>
      </>
    ),
    transfer: (
      <>
        <JitterRows
          label="Opacity Jitter"
          value={dyn.transfer.opacity}
          controls={BASIC}
          minimum="Minimum Opacity"
          onChange={(opacity) => setDyn('transfer', { opacity })}
        />
        <JitterRows
          label="Flow Jitter"
          value={dyn.transfer.flow}
          controls={BASIC}
          minimum="Minimum Flow"
          onChange={(flow) => setDyn('transfer', { flow })}
        />
      </>
    ),
    pose: (
      <div className="brush-group">
        <NumberField
          label="Tilt X"
          value={dyn.pose.tiltX}
          min={-90}
          max={90}
          width={48}
          onChange={(tiltX) => setDyn('pose', { tiltX })}
        />
        <NumberField
          label="Tilt Y"
          value={dyn.pose.tiltY}
          min={-90}
          max={90}
          width={48}
          onChange={(tiltY) => setDyn('pose', { tiltY })}
        />
        <Check
          label="Override Tilt"
          checked={dyn.pose.overrideTilt}
          onChange={(overrideTilt) => setDyn('pose', { overrideTilt })}
        />
        <NumberField
          label="Rotation"
          value={dyn.pose.rotation}
          min={0}
          max={360}
          suffix="°"
          width={52}
          onChange={(rotation) => setDyn('pose', { rotation })}
        />
        <Check
          label="Override Rotation"
          checked={dyn.pose.overrideRotation}
          onChange={(overrideRotation) => setDyn('pose', { overrideRotation })}
        />
        <NumberField
          label="Pressure"
          value={pct(dyn.pose.pressure)}
          min={0}
          max={100}
          suffix="%"
          width={52}
          onChange={(v) => setDyn('pose', { pressure: v / 100 })}
        />
        <Check
          label="Override Pressure"
          checked={dyn.pose.overridePressure}
          onChange={(overridePressure) => setDyn('pose', { overridePressure })}
        />
      </div>
    ),
  };

  return (
    <div className="brush-settings">
      <div className="brush-sections" role="tablist" aria-label="Brush settings sections" aria-orientation="vertical">
        {SECTIONS.map(([id, label]) => (
          <div key={id} className={`brush-section${section === id ? ' active' : ''}`}>
            {id !== 'tip' && (
              <input
                type="checkbox"
                aria-label={`Use ${label}`}
                checked={enabled(id)}
                disabled={id === 'color' && painting.kind !== 'brush'}
                onChange={(e) => setDyn(id, { enabled: e.target.checked })}
              />
            )}
            <button type="button" role="tab" aria-selected={section === id} onClick={() => setSection(id)}>
              {label}
            </button>
          </div>
        ))}
      </div>
      <div className="brush-section-body" role="tabpanel" aria-label={SECTIONS.find((s) => s[0] === section)![1]}>
        {body[section]}
      </div>
      <canvas ref={preview} className="brush-preview-stroke" aria-label="Brush stroke preview" role="img" />
    </div>
  );
}
