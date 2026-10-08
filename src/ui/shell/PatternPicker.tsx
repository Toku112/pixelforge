/** A pattern picker: the chosen pattern's thumbnail; opened, the patterns to choose from. */
import { useEffect, useReducer, useRef, useState } from 'react';
import { useController } from '../AppContext';
import { Icon } from '../icons';
import { PatternList } from '../panels/PatternList';
import { PatternThumb } from '../PatternThumb';

export function PatternPicker({
  value,
  onChange,
  label = 'Pattern picker',
}: {
  value: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  const controller = useController();
  const library = controller.services.patterns;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => library.onChange(redraw), [library]);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (root.current?.contains(target)) return;
      // A dialog opened over the one holding the picker (Rename) is not "away".
      const backdrop = target?.closest('.modal-backdrop');
      if (backdrop && backdrop !== root.current?.closest('.modal-backdrop')) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [open]);
  const pattern = library.get(value);
  return (
    <div className="gradient-picker pattern-picker" ref={root}>
      <button
        type="button"
        className="gradient-picker-preview"
        aria-label={label}
        aria-expanded={open}
        title={pattern ? `${pattern.name} — click to choose another pattern` : 'Choose a pattern'}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        {pattern ? <PatternThumb pattern={pattern} size={20} /> : <Icon name="pattern" size={20} />}
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="brush-picker-panel gradient-picker-panel" role="group" aria-label="Patterns">
          <PatternList
            selectedId={value}
            onPick={(id) => {
              onChange(id);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
