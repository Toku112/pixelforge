/**
 * Numeric input with the reference app's conveniences: drag the label left/right
 * to scrub the value, arrow keys step it (Shift = ×10), and typed math is accepted
 * ("+10", "*2", "90-15"). Enter or leaving the field applies; Escape reverts.
 */
import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { evaluateNumberInput } from './number-expr';

export interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
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
  /**
   * Live preview while the label is scrubbed: receives every intermediate value,
   * and `onChange` receives only the final one on release (one undo step).
   */
  onPreview?: (value: number) => void;
  disabled?: boolean;
  /** Name read by screen readers when the visible label is ambiguous (e.g. "B:" for Blue). */
  ariaLabel?: string;
  /** The field a dialog focuses when it opens. */
  autofocus?: boolean;
}

export function NumberField({
  label,
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  precision = 0,
  suffix = '',
  width = 56,
  scrubRate = 1,
  title,
  hideLabel,
  onPreview,
  disabled = false,
  ariaLabel,
  autofocus,
}: NumberFieldProps) {
  const format = (v: number) => `${Number(v.toFixed(precision))}${suffix}`;
  // Text being typed; null when not editing (the field then shows the current value).
  const [draft, setDraft] = useState<string | null>(null);
  const scrub = useRef<{ x: number; start: number; last: number } | null>(null);
  const scrubbed = useRef(false);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const commit = () => {
    if (draft === null) return;
    const next = evaluateNumberInput(draft, value);
    // Leaving a field without changing it is not a change (no history step, no "Custom" preset).
    if (next !== null && clamp(next) !== Number(value.toFixed(precision))) onChange(clamp(next));
    setDraft(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // In a dialog, Enter applies the value and then presses OK (applied synchronously,
      // so OK sees it). Leaving the field first would stop the browser from submitting.
      e.preventDefault();
      const input = e.currentTarget;
      flushSync(commit);
      input.blur();
      input.form?.requestSubmit();
    } else if (e.key === 'Escape') {
      setDraft(null);
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
      onChange(next);
      setDraft(format(next));
    }
  };

  const onLabelPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrub.current = { x: e.clientX, start: value, last: value };
  };
  const onLabelPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    const s = scrub.current;
    if (!s) return;
    const delta = (e.clientX - s.x) * scrubRate * (e.shiftKey ? 10 : 1);
    const next = clamp(Number((s.start + delta).toFixed(precision)));
    if (next === s.last) return;
    s.last = next;
    (onPreview ?? onChange)(next);
  };
  const onLabelPointerUp = () => {
    const s = scrub.current;
    scrub.current = null;
    scrubbed.current = !!s && s.last !== s.start;
    if (s && onPreview && s.last !== s.start) onChange(s.last);
  };
  // A click on a label normally focuses its field; not after a scrub (so shortcuts like Undo still work).
  const onLabelClick = (e: MouseEvent<HTMLSpanElement>) => {
    if (scrubbed.current) e.preventDefault();
    scrubbed.current = false;
  };

  return (
    <label className={`number-field${disabled ? ' disabled' : ''}`} title={title}>
      <span
        className={hideLabel ? 'visually-hidden' : 'number-field-label'}
        onPointerDown={onLabelPointerDown}
        onPointerMove={onLabelPointerMove}
        onPointerUp={onLabelPointerUp}
        onPointerCancel={onLabelPointerUp}
        onClick={onLabelClick}
      >
        {label}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={draft ?? format(value)}
        disabled={disabled}
        style={{ width }}
        onFocus={(e) => {
          setDraft(format(value));
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        aria-label={ariaLabel ?? label}
        data-autofocus={autofocus || undefined}
      />
    </label>
  );
}
