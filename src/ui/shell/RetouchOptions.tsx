/**
 * The options bar of Blur, Sharpen and Smudge: the brush, Mode, Strength, angle, Sample All
 * Layers, Protect Detail (Sharpen) or Finger Painting (Smudge), and pen pressure for size.
 */
import { retouchModes, type RetouchMode } from '../../core/paint/retouch';
import type { PaintingTool } from '../../tools/paint/paint-tool';
import { useController } from '../AppContext';
import { NumberField } from '../controls/NumberField';
import { BrushPicker } from './BrushPicker';
import { AngleField, BrushSettingsToggle, PressureSizeToggle } from './PaintOptionParts';
import { useBrushOptions } from './use-brush-options';

export function RetouchOptionsBar({ tool }: { tool: PaintingTool }) {
  const controller = useController();
  const { bump } = useBrushOptions(tool);
  const r = tool.retouch;
  const set = (changes: Partial<typeof r>) => {
    tool.setRetouch(changes);
    bump();
  };
  const doc = controller.workspace.active?.doc;
  const modes = retouchModes(doc?.colorChannels ?? 3);
  return (
    <>
      <BrushPicker tool={tool} />
      <BrushSettingsToggle />
      <span className="options-divider" />
      <label className="option-field">
        Mode:
        <select
          className="option-select"
          aria-label="Mode"
          value={modes.some(([m]) => m === r.mode) ? r.mode : 'normal'}
          onChange={(e) => set({ mode: e.target.value as RetouchMode })}
        >
          {modes.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <NumberField
        label="Strength:"
        title={
          tool.kind === 'smudge'
            ? 'How far the colour is dragged'
            : tool.kind === 'blur'
              ? 'How strongly each stroke blurs'
              : 'How strongly each stroke sharpens'
        }
        value={Math.round(r.strength * 100)}
        min={1}
        max={100}
        suffix="%"
        width={46}
        onChange={(v) => set({ strength: v / 100 })}
      />
      <span className="options-divider" />
      <AngleField tool={tool} />
      <label
        className="option-check"
        title="Work with what all visible layers show; the result goes on the active layer"
      >
        <input
          type="checkbox"
          checked={r.sampleAllLayers}
          onChange={(e) => set({ sampleAllLayers: e.target.checked })}
        />
        Sample All Layers
      </label>
      {tool.kind === 'sharpen' && (
        <label className="option-check" title="Sharpen without bringing out noise, colour fringes or halos">
          <input type="checkbox" checked={r.protectDetail} onChange={(e) => set({ protectDetail: e.target.checked })} />
          Protect Detail
        </label>
      )}
      {tool.kind === 'smudge' && (
        <label
          className="option-check"
          title="Start each stroke with the foreground colour (Alt switches it for a stroke)"
        >
          <input
            type="checkbox"
            checked={r.fingerPainting}
            onChange={(e) => set({ fingerPainting: e.target.checked })}
          />
          Finger Painting
        </label>
      )}
      <PressureSizeToggle tool={tool} />
    </>
  );
}
