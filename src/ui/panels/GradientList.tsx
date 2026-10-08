/**
 * Gradient presets in collapsible groups (the Gradients panel, the options bar's
 * picker and the Gradient Editor): click one to use it with the Gradient tool (or,
 * with `onPick`, to hand it to the caller), double-click to rename it.
 */
import { useEffect, useReducer, useState } from 'react';
import { useController } from '../AppContext';
import { GradientStrip } from '../GradientStrip';
import { Icon } from '../icons';
import { useUi } from '../state/ui-store';

export function GradientList({
  onChoose,
  onPick,
  selectedId,
}: {
  /** After a preset was chosen for the tool (e.g. to close a popup). */
  onChoose?: () => void;
  /** Instead of choosing for the tool: hands the preset's id over. */
  onPick?: (id: string) => void;
  /** The highlighted preset (default: the Gradient tool's). */
  selectedId?: string | null;
}) {
  const controller = useController();
  const library = controller.services.gradients;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => library.onChange(redraw), [library]);
  useUi((s) => s.toolOptionsVersion);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const selected = selectedId === undefined ? controller.tools.gradient.options.presetId : selectedId;
  const method = controller.tools.gradient.options.method;
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
              <div className="gradient-grid" role="listbox" aria-label={`${g.name} gradients`}>
                {g.gradients.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    role="option"
                    aria-selected={e.id === selected}
                    aria-label={e.gradient.name}
                    title={e.gradient.name}
                    className={`gradient-chip${e.id === selected ? ' selected' : ''}`}
                    onClick={() => {
                      if (onPick) return onPick(e.id);
                      controller.chooseGradient(e.id);
                      onChoose?.();
                    }}
                    onDoubleClick={() => void controller.renameGradient(e.id)}
                  >
                    <GradientStrip gradient={e.gradient} method={method} width={30} height={30} />
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
