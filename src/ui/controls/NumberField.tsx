/**
 * Numeric input with the reference app's conveniences: drag the label left/right
 * to scrub the value, arrow keys step it (Shift = ×10), and typed math is accepted
 * ("+10", "*2", "90-15"). Enter or leaving the field applies; Escape reverts.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { evaluateNumberInput } from './number-expr';

export interface NumberFieldProps {
  label: string;
  value: number;
  onChange(value: number): void;
  min?: number;
  max?: number;
  step?: number;
  /** Decimal places shown. */
  precision?: number;
  suffix?: string;
  width?: number;
  /** Units of value per pixel dragged on the label. */
  scrubRate?: number;
  title?: string;
  /** Hide the label visually (still read by screen readers). */
  hideLabel?: boolean;
}

export function NumberField({ label, value, onChange, min = -Infinity, max = Infinity, step = 1, precision = 0, suffix = '', width = 56, scrubRate = 1, title, hideLabel }: NumberFieldProps) {
  const format = (v: number) => `${Number(v.toFixed(precision))}${suffix}`;
  const [text, setText] = useState(format(value));
  const [editing, setEditing] = useState(false);
  const scrub = useRef<{ x: number; start: number } | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  useEffect(() => {
    if (!editing) setText(format(value));
  });

  const commit = () => {
    const next = evaluateNumberInput(text, value);
    if (next !== null) onChange(clamp(next));
    setEditing(false);
    setText(format(next === null ? value : clamp(next)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setEditing(false);
      setText(format(value));
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
      onChange(next);
      setText(format(next));
    }
  };

  const onLabelPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    scrub.current = { x: e.clientX, start: value };
  };
  const onLabelPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    if (!scrub.current) return;
    const delta = (e.clientX - scrub.current.x) * scrubRate * (e.shiftKey ? 10 : 1);
    onChange(clamp(Number((scrub.current.start + delta).toFixed(precision))));
  };
  const onLabelPointerUp = () => {
    scrub.current = null;
  };

  return (
    <label className="number-field" title={title}>
      <span className={hideLabel ? 'visually-hidden' : 'number-field-label'} onPointerDown={onLabelPointerDown} onPointerMove={onLabelPointerMove} onPointerUp={onLabelPointerUp}>
        {label}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        style={{ width }}
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        aria-label={label}
      />
    </label>
  );
}
