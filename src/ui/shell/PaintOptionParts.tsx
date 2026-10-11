/** Options bar controls the painting tools share: Brush Settings, build-up, angle and pen pressure for size. */
import { DEFAULT_DYNAMICS } from '../../core/paint/dynamics';
import type { PaintingTool } from '../../tools/paint/paint-tool';
import { isPanelOpen } from '../dock/dock-model';
import { useController } from '../AppContext';
import { NumberField } from '../controls/NumberField';
import { Icon } from '../icons';
import { useUi } from '../state/ui-store';
import { useBrushOptions } from './use-brush-options';

export function BrushSettingsToggle() {
  const controller = useController();
  const open = useUi((s) => isPanelOpen(s.dock, 'brush-settings'));
  return (
    <button
      type="button"
      className={`option-icon${open ? ' active' : ''}`}
      aria-pressed={open}
      aria-label="Toggle the Brush Settings panel"
      title="Toggle the Brush Settings panel (F5)"
      onClick={() => controller.commands.run('window.brushSettings')}
    >
      <Icon name="brushSettings" size={16} />
    </button>
  );
}

/** Airbrush-style build-up (Brush Settings > Build-up). */
export function BuildUpToggle({ tool }: { tool: PaintingTool }) {
  const { o, set } = useBrushOptions(tool);
  const dynamics = o.dynamics ?? DEFAULT_DYNAMICS;
  return (
    <button
      type="button"
      className={`option-icon${dynamics.buildUp ? ' active' : ''}`}
      aria-pressed={dynamics.buildUp}
      aria-label="Airbrush-style build-up"
      title="Airbrush-style build-up: keeps working while the pointer rests"
      onClick={() => set({ dynamics: { ...dynamics, buildUp: !dynamics.buildUp } })}
    >
      <Icon name="airbrush" size={16} />
    </button>
  );
}

export function AngleField({ tool }: { tool: PaintingTool }) {
  const { o, set } = useBrushOptions(tool);
  return (
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
  );
}

export function PressureSizeToggle({ tool }: { tool: PaintingTool }) {
  const { o, set } = useBrushOptions(tool);
  return (
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
  );
}
