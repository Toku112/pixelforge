/**
 * The brush picker in the options bar: the current tip and size; opened, it sets
 * size, hardness, angle, roundness and flips, and chooses the round tip or one of
 * the sampled tips from Edit > Define Brush Preset (which can be deleted here).
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import type { BrushTip } from '../../core/paint/brush';
import type { PaintingTool } from '../../tools/paint/paint-tool';
import { useController } from '../AppContext';
import { NumberField } from '../controls/NumberField';
import { useUi } from '../state/ui-store';

/** A tip drawn as dark paint on white into a square of `box` CSS pixels (sampled, so large tips stay quick). */
export function TipThumbnail({
  tip,
  box,
  roundHardness,
}: {
  tip: BrushTip | null;
  box: number;
  roundHardness?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    el.width = box;
    el.height = box;
    const image = ctx.createImageData(box, box);
    const scale = tip ? Math.min(1, (box - 4) / Math.max(tip.width, tip.height)) : 1;
    for (let y = 0; y < box; y++) {
      for (let x = 0; x < box; x++) {
        let cover: number;
        if (tip) {
          const tx = Math.floor((x - box / 2) / scale + tip.width / 2);
          const ty = Math.floor((y - box / 2) / scale + tip.height / 2);
          cover = tx < 0 || ty < 0 || tx >= tip.width || ty >= tip.height ? 0 : tip.data[ty * tip.width + tx]! / 255;
        } else {
          // The round tip: a disc with a soft rim set by hardness.
          const r = box / 2 - 2;
          const d = Math.hypot(x + 0.5 - box / 2, y + 0.5 - box / 2);
          const h = roundHardness ?? 1;
          cover = d >= r ? 0 : d <= r * h ? 1 : 1 - (d - r * h) / (r * (1 - h));
        }
        const v = Math.round(255 - cover * 255);
        image.data.set([v, v, v, 255], (y * box + x) * 4);
      }
    }
    ctx.putImageData(image, 0, 0);
  }, [tip, box, roundHardness]);
  return <canvas ref={canvas} className="tip-thumb" style={{ width: box, height: box }} />;
}

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
  const tips = library.list();
  const current = o.tip ? (library.get(o.tip) ?? null) : null;
  const set = (changes: Partial<typeof o>) => {
    tool.setOptions(changes);
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

  const choose = (tip: BrushTip | null) =>
    set(tip ? { tip: tip.id, size: Math.max(tip.width, tip.height) } : { tip: null, size: o.tip ? 30 : o.size });

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
        <div className="brush-picker-panel" role="group" aria-label="Brush settings">
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
          </div>
          <div className="brush-tips" role="listbox" aria-label="Brush tips">
            <button
              type="button"
              role="option"
              aria-selected={o.tip === null}
              aria-label="Round"
              title="Round"
              className="brush-tip"
              onClick={() => choose(null)}
            >
              <TipThumbnail tip={null} box={36} roundHardness={o.hardness} />
            </button>
            {tips.map((tip) => (
              <button
                key={tip.id}
                type="button"
                role="option"
                aria-selected={o.tip === tip.id}
                aria-label={tip.name}
                title={`${tip.name} (${tip.width} × ${tip.height})`}
                className="brush-tip"
                onClick={() => choose(tip)}
              >
                <TipThumbnail tip={tip} box={36} />
              </button>
            ))}
          </div>
          {current && (
            <button
              type="button"
              className="option-button"
              onClick={() => {
                void library.remove(current.id);
                set({ tip: null, size: 30 });
              }}
            >
              Delete “{current.name}”
            </button>
          )}
          {tips.length === 0 && <p className="hint">Make your own tips with Edit › Define Brush Preset.</p>}
        </div>
      )}
    </div>
  );
}
