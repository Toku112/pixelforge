/**
 * The brush preset picker in the options bar: the current tip and size; opened, it
 * sets size, hardness, angle, roundness and flips, makes a preset of them, and lists
 * the brush presets (as the Brushes panel does) to choose from.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import type { PaintingTool } from '../../tools/paint/paint-tool';
import { useController } from '../AppContext';
import { NumberField } from '../controls/NumberField';
import { Icon } from '../icons';
import { BrushPresetList } from '../panels/BrushPresetList';
import { useUi } from '../state/ui-store';
import { TipThumbnail } from './TipThumbnail';

export function BrushPicker({ tool }: { tool: PaintingTool }) {
  const controller = useController();
  const bump = useUi((s) => s.bumpToolOptions);
  useUi((s) => s.toolOptionsVersion);
  const [open, setOpen] = useState(false);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const library = controller.services.brushes;
  useEffect(() => library.onChange(redraw), [library]);
  const root = useRef<HTMLDivElement>(null);
  const o = tool.options;
  const current = o.tip ? (library.get(o.tip) ?? null) : null;
  const set = (changes: Partial<typeof o>) => {
    tool.setOptions(changes);
    bump();
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      // Dialogs opened from the list (Rename) are not "away".
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
    <div className="brush-picker" ref={root}>
      <button
        type="button"
        className="brush-picker-button"
        aria-label="Brush preset picker"
        aria-expanded={open}
        title="Brush preset picker"
        onClick={() => setOpen(!open)}
      >
        <TipThumbnail tip={current} box={20} roundHardness={o.hardness} />
        <span>{o.size}</span>
      </button>
      {open && (
        <div className="brush-picker-panel brush-picker-presets" role="group" aria-label="Brush settings">
          <div className="brush-picker-fields">
            <NumberField
              label="Size"
              value={o.size}
              min={1}
              max={5000}
              suffix=" px"
              width={64}
              onChange={(size) => set({ size })}
            />
            <NumberField
              label="Hardness"
              value={Math.round(o.hardness * 100)}
              min={0}
              max={100}
              suffix="%"
              width={52}
              disabled={o.tip !== null}
              onChange={(v) => set({ hardness: v / 100 })}
            />
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
              value={Math.round(o.roundness * 100)}
              min={1}
              max={100}
              suffix="%"
              width={52}
              onChange={(v) => set({ roundness: v / 100 })}
            />
            <label className="option-check">
              <input type="checkbox" checked={o.flipX} onChange={(e) => set({ flipX: e.target.checked })} />
              Flip X
            </label>
            <label className="option-check">
              <input type="checkbox" checked={o.flipY} onChange={(e) => set({ flipY: e.target.checked })} />
              Flip Y
            </label>
            <button
              type="button"
              className="option-icon"
              aria-label="New brush preset"
              title="New brush preset from these settings"
              onClick={() => controller.commands.run('brushes.newPreset')}
            >
              <Icon name="newLayer" size={16} />
            </button>
          </div>
          <BrushPresetList strokesShown={false} />
        </div>
      )}
    </div>
  );
}
