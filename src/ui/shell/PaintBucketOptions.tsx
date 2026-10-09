/**
 * The Paint Bucket's options bar: what it fills with (the foreground colour or a
 * pattern, with the pattern picker), Mode, Opacity, Tolerance, Anti-alias, Contiguous
 * and All Layers.
 */
import { BLEND_MODE_LABELS, brushModeMenu } from '../../core/composite/blend';
import type { BucketSource, PaintBucketOptions, PaintBucketTool } from '../../tools/paint-bucket/paint-bucket-tool';
import { useController } from '../AppContext';
import { NumberField } from '../controls/NumberField';
import { useUi } from '../state/ui-store';
import { PatternPicker } from './PatternPicker';

export function PaintBucketOptionsBar({ tool }: { tool: PaintBucketTool }) {
  const controller = useController();
  const bump = useUi((s) => s.bumpToolOptions);
  useUi((s) => s.toolOptionsVersion);
  const o = tool.options;
  const set = (changes: Partial<PaintBucketOptions>) => {
    tool.setOptions(changes);
    bump();
  };
  const doc = controller.workspace.active?.doc;
  const layer = doc?.activeLayer;
  // Behind and Clear need transparency that may change (not the Background or locked transparency).
  const alphaEditable = layer?.kind === 'pixel' && layer.buffer.format.hasAlpha && !layer.locks.transparency;
  return (
    <>
      <select
        className="option-select"
        aria-label="Fill with"
        title="What the Paint Bucket fills with"
        value={o.source}
        onChange={(e) => set({ source: e.target.value as BucketSource })}
      >
        <option value="foreground">Foreground</option>
        <option value="pattern">Pattern</option>
      </select>
      <PatternPicker
        value={o.patternId}
        label="Paint Bucket pattern"
        disabled={o.source !== 'pattern'}
        onChange={(id) => controller.choosePattern(id)}
      />
      <span className="options-divider" />
      <label className="option-field">
        Mode:
        <select
          className="option-select"
          aria-label="Paint Bucket mode"
          value={o.mode}
          onChange={(e) => set({ mode: e.target.value as PaintBucketOptions['mode'] })}
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
      <NumberField
        label="Tolerance:"
        value={o.tolerance}
        min={0}
        max={255}
        width={40}
        title="How far a colour may be from the clicked colour and still be filled"
        onChange={(v) => set({ tolerance: Math.round(v) })}
      />
      <span className="options-divider" />
      <label className="option-check">
        <input type="checkbox" checked={o.antiAlias} onChange={(e) => set({ antiAlias: e.target.checked })} />
        Anti-alias
      </label>
      <label className="option-check" title="Fill only what joins the clicked pixel">
        <input type="checkbox" checked={o.contiguous} onChange={(e) => set({ contiguous: e.target.checked })} />
        Contiguous
      </label>
      <label className="option-check" title="Compare the colours of all visible layers, not only the active one">
        <input type="checkbox" checked={o.allLayers} onChange={(e) => set({ allLayers: e.target.checked })} />
        All Layers
      </label>
    </>
  );
}
