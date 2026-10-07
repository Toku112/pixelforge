/**
 * The Color Picker: a saturation/brightness field for the current hue, a hue strip,
 * the new and current colours, and HSB, RGB, L*a*b* and hexadecimal fields that all
 * stay in step. Colours are sRGB until colour management (Phase 7).
 *
 * Keyboard: in the field, arrows change saturation (←/→) and brightness (↑/↓) by
 * 1 % (Shift: 10 %); on the hue strip, ↑/↓ change the hue by 1° (Shift: 10°).
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  hexToRgb,
  hsbToRgb,
  labToRgb,
  rgb8,
  rgbToHex,
  rgbToHsb,
  rgbToLab,
  type HSB,
  type RGB,
} from '../../core/color/color';
import { NumberField } from '../controls/NumberField';
import type { DialogRequest } from '../state/ui-store';
import { useUi } from '../state/ui-store';
import { Modal } from './Modal';

const css = (c: RGB) => `#${rgbToHex(c)}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Tracks a pointer drag over an element, reporting positions as 0–1 fractions. */
function useDrag(onMove: (fx: number, fy: number) => void) {
  const active = useRef(false);
  const report = (e: PointerEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    onMove(clamp((e.clientX - box.left) / box.width, 0, 1), clamp((e.clientY - box.top) / box.height, 0, 1));
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus();
      active.current = true;
      report(e);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (active.current) report(e);
    },
    onPointerUp: () => {
      active.current = false;
    },
  };
}

export function ColorPickerDialog({ dialog }: { dialog: Extract<DialogRequest, { kind: 'color-picker' }> }) {
  const close = useUi((s) => s.closeDialog);
  // HSB is the source of truth so the hue survives greys and black.
  const [hsb, setHsb] = useState<HSB>(() => rgbToHsb(dialog.color));
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const rgb = hsbToRgb(hsb);
  const lab = rgbToLab(rgb);
  const [r, g, b] = rgb8(rgb);

  /** Sets a colour from RGB (or Lab, hex): keeps the hue when the new colour has none. */
  const setRgb = (c: RGB) => {
    const next = rgbToHsb(c);
    setHsb(next.s === 0 || next.b === 0 ? { ...next, h: hsb.h } : next);
  };

  const field = useDrag((fx, fy) => setHsb((h) => ({ ...h, s: fx, b: 1 - fy })));
  const strip = useDrag((_fx, fy) => setHsb((h) => ({ ...h, h: (1 - fy) * 360 })));

  const fieldKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = (e.shiftKey ? 10 : 1) / 100;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    setHsb((h) => ({ ...h, s: clamp(h.s + move[0], 0, 1), b: clamp(h.b + move[1], 0, 1) }));
  };
  const stripKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    setHsb((h) => ({ ...h, h: clamp(h.h + (e.key === 'ArrowUp' ? step : -step), 0, 360) }));
  };

  const cancel = () => (close(dialog), dialog.resolve(null));
  const ok = () => (close(dialog), dialog.resolve(rgb));

  return (
    <Modal title={dialog.title} onCancel={cancel} className="color-picker">
      <div className="picker-body">
        <div
          className="picker-field"
          role="slider"
          tabIndex={0}
          aria-label="Saturation and brightness"
          aria-valuetext={`Saturation ${Math.round(hsb.s * 100)} %, brightness ${Math.round(hsb.b * 100)} %`}
          data-autofocus
          style={{ backgroundColor: css(hsbToRgb({ h: hsb.h, s: 1, b: 1 })) }}
          onKeyDown={fieldKeys}
          {...field}
        >
          <span className="picker-marker" style={{ left: `${hsb.s * 100}%`, top: `${(1 - hsb.b) * 100}%` }} />
        </div>
        <div
          className="picker-hue"
          role="slider"
          tabIndex={0}
          aria-label="Hue"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsb.h)}
          onKeyDown={stripKeys}
          {...strip}
        >
          <span className="picker-hue-marker" style={{ top: `${(1 - hsb.h / 360) * 100}%` }} />
        </div>
        <div className="picker-side">
          <div className="picker-swatches">
            <span className="picker-label">new</span>
            <span className="picker-swatch" data-testid="picker-new" style={{ background: css(rgb) }} />
            <span className="picker-swatch" style={{ background: css(dialog.color) }} />
            <span className="picker-label">current</span>
          </div>
          <div className="picker-fields">
            <NumberField
              label="H:"
              ariaLabel="Hue"
              value={Math.round(hsb.h)}
              min={0}
              max={360}
              suffix="°"
              width={46}
              onChange={(h) => setHsb({ ...hsb, h })}
            />
            <NumberField
              label="L:"
              ariaLabel="Lightness"
              value={Math.round(lab.L)}
              min={0}
              max={100}
              width={46}
              onChange={(L) => setRgb(labToRgb({ ...lab, L }))}
            />
            <NumberField
              label="S:"
              ariaLabel="Saturation"
              value={Math.round(hsb.s * 100)}
              min={0}
              max={100}
              suffix="%"
              width={46}
              onChange={(s) => setHsb({ ...hsb, s: s / 100 })}
            />
            <NumberField
              label="a:"
              ariaLabel="a (green–red)"
              value={Math.round(lab.a)}
              min={-128}
              max={127}
              width={46}
              onChange={(a) => setRgb(labToRgb({ ...lab, a }))}
            />
            <NumberField
              label="B:"
              ariaLabel="Brightness"
              value={Math.round(hsb.b * 100)}
              min={0}
              max={100}
              suffix="%"
              width={46}
              onChange={(v) => setHsb({ ...hsb, b: v / 100 })}
            />
            <NumberField
              label="b:"
              ariaLabel="b (blue–yellow)"
              value={Math.round(lab.b)}
              min={-128}
              max={127}
              width={46}
              onChange={(bv) => setRgb(labToRgb({ ...lab, b: bv }))}
            />
            <NumberField
              label="R:"
              ariaLabel="Red"
              value={r}
              min={0}
              max={255}
              width={46}
              onChange={(v) => setRgb({ ...rgb, r: v / 255 })}
            />
            <span />
            <NumberField
              label="G:"
              ariaLabel="Green"
              value={g}
              min={0}
              max={255}
              width={46}
              onChange={(v) => setRgb({ ...rgb, g: v / 255 })}
            />
            <span />
            <NumberField
              label="B:"
              value={b}
              min={0}
              max={255}
              width={46}
              onChange={(v) => setRgb({ ...rgb, b: v / 255 })}
              ariaLabel="Blue"
            />
          </div>
          <label className="picker-hex">
            #
            <input
              type="text"
              aria-label="Hexadecimal colour"
              value={hexDraft ?? rgbToHex(rgb)}
              maxLength={7}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setHexDraft(e.target.value)}
              onBlur={() => {
                const parsed = hexDraft !== null ? hexToRgb(hexDraft) : null;
                if (parsed) setRgb(parsed);
                setHexDraft(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
            />
          </label>
        </div>
      </div>
      <div className="modal-buttons">
        <button type="button" className="primary-button" onClick={ok}>
          OK
        </button>
        <button type="button" onClick={cancel}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
