/**
 * Swatches panel (Window > Swatches): colours in groups. Click a swatch for the
 * foreground colour (Ctrl/Cmd-click: the background), double-click to rename it;
 * buttons make a group, add the foreground colour, and delete the selected swatch.
 * Its menu imports .ase/.aco files and restores the default swatches.
 */
import { useEffect, useReducer, useState } from 'react';
import { rgbToHex } from '../../core/color/color';
import { useController } from '../AppContext';
import { Icon } from '../icons';
import { useUi } from '../state/ui-store';

export function SwatchesPanel() {
  const controller = useController();
  const library = controller.services.swatches;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => library.onChange(redraw), [library]);
  useUi((s) => s.toolOptionsVersion);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const selected = controller.currentSwatchId;
  const run = (id: string) => () => controller.commands.run(id);
  const mac = controller.platform === 'mac';
  return (
    <div className="swatches-panel">
      <div className="swatch-groups">
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
                <div className="swatch-grid" role="listbox" aria-label={`${g.name} swatches`}>
                  {g.swatches.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="option"
                      aria-selected={s.id === selected}
                      aria-label={s.name}
                      title={`${s.name} (#${rgbToHex(s.color)}) — click: foreground, ${mac ? '⌘' : 'Ctrl'}-click: background`}
                      className={`swatch-chip${s.id === selected ? ' selected' : ''}`}
                      style={{ background: `#${rgbToHex(s.color)}` }}
                      onClick={(e) => controller.chooseSwatch(s.id, e.ctrlKey || e.metaKey)}
                      onDoubleClick={() => void controller.renameSwatch(s.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="panel-footer">
        <button
          type="button"
          className="icon-button"
          aria-label="New swatch group"
          title="New swatch group"
          onClick={run('swatches.newGroup')}
        >
          <Icon name="newGroup" size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="New swatch"
          title="New swatch from the foreground color"
          onClick={run('swatches.new')}
        >
          <Icon name="newLayer" size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Delete swatch"
          title="Delete the selected swatch"
          disabled={!controller.commands.isEnabled('swatches.delete')}
          onClick={run('swatches.delete')}
        >
          <Icon name="trash" size={16} />
        </button>
      </div>
    </div>
  );
}
