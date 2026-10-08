/**
 * Patterns in collapsible groups (the Patterns panel and the pattern pickers): click
 * one to choose it, double-click to rename it.
 */
import { useEffect, useReducer, useState } from 'react';
import { useController } from '../AppContext';
import { Icon } from '../icons';
import { PatternThumb } from '../PatternThumb';

export function PatternList({ selectedId, onPick }: { selectedId: string | null; onPick: (id: string) => void }) {
  const controller = useController();
  const library = controller.services.patterns;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => library.onChange(redraw), [library]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  return (
    <div className="gradient-groups">
      {library.groups().map((g) => {
        const open = !collapsed.has(g.name);
        return (
          <div key={g.name} role="group" aria-label={g.name} className="swatch-group">
            <button
              type="button"
              className="preset-group-header"
              aria-expanded={open}
              onClick={() => {
                const next = new Set(collapsed);
                if (next.has(g.name)) next.delete(g.name);
                else next.add(g.name);
                setCollapsed(next);
              }}
            >
              <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
              <Icon name="folder" size={14} />
              <span>{g.name}</span>
            </button>
            {open && (
              <div className="gradient-grid" role="listbox" aria-label={`${g.name} patterns`}>
                {g.patterns.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={p.id === selectedId}
                    aria-label={p.name}
                    title={`${p.name} (${p.width} × ${p.height} pixels)`}
                    className={`gradient-chip${p.id === selectedId ? ' selected' : ''}`}
                    onClick={() => onPick(p.id)}
                    onDoubleClick={() => void controller.renamePattern(p.id)}
                  >
                    <PatternThumb pattern={p} size={30} />
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
