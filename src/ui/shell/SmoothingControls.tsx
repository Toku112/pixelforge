/**
 * The options bar's Smoothing field and its options (the gear): Pulled String Mode,
 * Stroke Catch-up, Catch-up on Stroke End, Adjust for Zoom.
 */
import { useEffect, useRef, useState } from 'react';
import type { SmoothingOptions } from '../../core/paint/smoothing';
import type { PaintingTool } from '../../tools/paint/paint-tool';
import { NumberField } from '../controls/NumberField';
import { Icon } from '../icons';
import { useUi } from '../state/ui-store';

const OPTIONS: [keyof Omit<SmoothingOptions, 'amount' | 'curves'>, string, string][] = [
  ['pulledString', 'Pulled String Mode', 'Paint only while the string is taut; small moves leave no mark'],
  ['catchUp', 'Stroke Catch-up', 'The paint keeps catching up with the pointer while it rests'],
  ['catchUpOnEnd', 'Catch-up on Stroke End', 'Releasing finishes the stroke where the pointer is'],
  ['adjustForZoom', 'Adjust for Zoom', 'Less smoothing when zoomed in, more when zoomed out'],
];

export function SmoothingControls({ tool }: { tool: PaintingTool }) {
  const bump = useUi((s) => s.bumpToolOptions);
  useUi((s) => s.toolOptionsVersion);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const s = tool.smoothing;
  const set = (changes: Partial<SmoothingOptions>) => {
    tool.setSmoothing(changes);
    bump();
  };

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

  return (
    <div className="smoothing" ref={root}>
      <NumberField
        label="Smoothing:"
        value={Math.round(s.amount * 100)}
        min={0}
        max={100}
        suffix="%"
        width={46}
        onChange={(v) => set({ amount: v / 100 })}
      />
      <button
        type="button"
        className="option-icon"
        aria-label="Smoothing options"
        aria-expanded={open}
        title="Smoothing options"
        onClick={() => setOpen(!open)}
      >
        <Icon name="gear" size={16} />
      </button>
      {open && (
        <div className="brush-picker-panel smoothing-panel" role="group" aria-label="Smoothing options">
          {OPTIONS.map(([key, label, hint]) => (
            <label key={key} className="option-check" title={hint}>
              <input type="checkbox" checked={s[key]} onChange={(e) => set({ [key]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
