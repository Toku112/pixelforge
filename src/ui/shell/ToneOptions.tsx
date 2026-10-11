/**
 * The options bars of Dodge and Burn (Range, Exposure, build-up, Protect Tones) and of
 * the Sponge (Mode, Flow, build-up, Vibrance), with the brush, smoothing, angle and pen
 * pressure for size.
 */
import { TONE_RANGES, type ToneRange } from '../../core/paint/tone';
import type { PaintingTool } from '../../tools/paint/paint-tool';
import { NumberField } from '../controls/NumberField';
import { BrushPicker } from './BrushPicker';
import { AngleField, BrushSettingsToggle, BuildUpToggle, PressureSizeToggle } from './PaintOptionParts';
import { useBrushOptions } from './use-brush-options';
import { SmoothingControls } from './SmoothingControls';

const percent = (v: number) => Math.round(v * 100);

export function DodgeOptionsBar({ tool }: { tool: PaintingTool }) {
  const { bump } = useBrushOptions(tool);
  const t = tool.tone;
  const setTone = (changes: Partial<typeof t>) => {
    tool.setTone(changes);
    bump();
  };
  return (
    <>
      <BrushPicker tool={tool} />
      <BrushSettingsToggle />
      <span className="options-divider" />
      <label className="option-field">
        Range:
        <select
          className="option-select"
          aria-label="Range"
          title="The tones changed most"
          value={t.range}
          onChange={(e) => setTone({ range: e.target.value as ToneRange })}
        >
          {TONE_RANGES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <NumberField
        label="Exposure:"
        title="How strongly a stroke lightens (Dodge) or darkens (Burn)"
        value={percent(t.exposure)}
        min={1}
        max={100}
        suffix="%"
        width={46}
        onChange={(v) => setTone({ exposure: v / 100 })}
      />
      <BuildUpToggle tool={tool} />
      <SmoothingControls tool={tool} />
      <span className="options-divider" />
      <AngleField tool={tool} />
      <label className="option-check" title="Keep colours from shifting in hue or clipping to white or black">
        <input type="checkbox" checked={t.protectTones} onChange={(e) => setTone({ protectTones: e.target.checked })} />
        Protect Tones
      </label>
      <PressureSizeToggle tool={tool} />
    </>
  );
}

export function SpongeOptionsBar({ tool }: { tool: PaintingTool }) {
  const { o, set, bump } = useBrushOptions(tool);
  const sp = tool.sponge;
  const setSponge = (changes: Partial<typeof sp>) => {
    tool.setSponge(changes);
    bump();
  };
  return (
    <>
      <BrushPicker tool={tool} />
      <BrushSettingsToggle />
      <span className="options-divider" />
      <label className="option-field">
        Mode:
        <select
          className="option-select"
          aria-label="Sponge mode"
          value={sp.saturate ? 'saturate' : 'desaturate'}
          onChange={(e) => setSponge({ saturate: e.target.value === 'saturate' })}
        >
          <option value="desaturate">Desaturate</option>
          <option value="saturate">Saturate</option>
        </select>
      </label>
      <NumberField
        label="Flow:"
        title="How quickly the colours change"
        value={percent(o.flow)}
        min={1}
        max={100}
        suffix="%"
        width={46}
        onChange={(v) => set({ flow: v / 100 })}
      />
      <BuildUpToggle tool={tool} />
      <SmoothingControls tool={tool} />
      <span className="options-divider" />
      <AngleField tool={tool} />
      <label
        className="option-check"
        title="Spare colours that are nearly fully saturated or unsaturated, so they do not clip"
      >
        <input type="checkbox" checked={sp.vibrance} onChange={(e) => setSponge({ vibrance: e.target.checked })} />
        Vibrance
      </label>
      <PressureSizeToggle tool={tool} />
    </>
  );
}
