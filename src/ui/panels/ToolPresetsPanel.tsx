/**
 * Tool Presets panel (Window > Tool Presets): tools saved with their settings. Click
 * one to switch to its tool with those settings; "Current Tool Only" lists the active
 * tool's presets only.
 */
import { useEffect, useReducer, useState } from 'react';
import { useController } from '../AppContext';
import { Icon } from '../icons';
import { useUi } from '../state/ui-store';
import { toolIcon } from '../tool-icons';

export function ToolPresetList({ currentOnly }: { currentOnly: boolean }) {
  const controller = useController();
  const library = controller.services.toolPresets;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => library.onChange(redraw), [library]);
  const toolId = useUi((s) => s.activeToolId);
  useUi((s) => s.toolOptionsVersion);
  const presets = library.list(currentOnly ? toolId : undefined);
  const selected = controller.currentToolPresetId;
  if (presets.length === 0)
    return <p className="hint">{currentOnly ? 'No presets for this tool yet.' : 'No tool presets yet.'}</p>;
  return (
    <div className="tool-preset-list" role="listbox" aria-label="Tool presets">
      {presets.map((p) => (
        <div
          key={p.id}
          role="option"
          aria-selected={p.id === selected}
          tabIndex={p.id === selected ? 0 : -1}
          className={`preset-row${p.id === selected ? ' selected' : ''}`}
          onClick={() => controller.chooseToolPreset(p.id)}
          onDoubleClick={() => void controller.renameToolPreset(p.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              controller.chooseToolPreset(p.id);
            }
          }}
        >
          <Icon name={toolIcon(p.toolId)} size={16} />
          <span className="preset-name">{p.name}</span>
        </div>
      ))}
    </div>
  );
}

export function ToolPresetsPanel() {
  const controller = useController();
  useUi((s) => s.toolOptionsVersion);
  useUi((s) => s.activeToolId);
  const [currentOnly, setCurrentOnly] = useState(false);
  const run = (id: string) => () => controller.commands.run(id);
  return (
    <div className="tool-presets-panel">
      <ToolPresetList currentOnly={currentOnly} />
      <div className="panel-footer">
        <label className="option-check">
          <input type="checkbox" checked={currentOnly} onChange={(e) => setCurrentOnly(e.target.checked)} />
          Current Tool Only
        </label>
        <span className="panel-footer-spacer" />
        <button
          type="button"
          className="icon-button"
          aria-label="New tool preset"
          title="New tool preset from the current tool"
          disabled={!controller.commands.isEnabled('toolPresets.new')}
          onClick={run('toolPresets.new')}
        >
          <Icon name="newLayer" size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Delete tool preset"
          title="Delete the selected tool preset"
          disabled={!controller.commands.isEnabled('toolPresets.delete')}
          onClick={run('toolPresets.delete')}
        >
          <Icon name="trash" size={16} />
        </button>
      </div>
    </div>
  );
}
