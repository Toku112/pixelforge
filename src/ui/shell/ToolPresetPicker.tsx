/** The options bar's tool preset picker (the tool's icon): the active tool's presets, and making one. */
import { useEffect, useRef, useState } from 'react';
import { useController } from '../AppContext';
import { Icon } from '../icons';
import { ToolPresetList } from '../panels/ToolPresetsPanel';
import { useUi } from '../state/ui-store';
import { toolIcon } from '../tool-icons';

export function ToolPresetPicker() {
  const controller = useController();
  const toolId = useUi((s) => s.activeToolId);
  useUi((s) => s.toolOptionsVersion);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const tool = controller.tools.byId.get(toolId);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
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
    <div className="tool-preset-picker" ref={root}>
      <button
        type="button"
        className="options-tool-icon"
        aria-label="Tool preset picker"
        aria-expanded={open}
        title={`${tool?.name ?? ''} — tool presets`}
        onClick={() => setOpen(!open)}
      >
        <Icon name={toolIcon(toolId)} size={18} />
      </button>
      {open && (
        <div className="brush-picker-panel tool-preset-panel" role="group" aria-label="Tool presets">
          <div className="tool-preset-head">
            <span>{tool?.name}</span>
            <button
              type="button"
              className="option-icon"
              aria-label="New tool preset"
              title="New tool preset from the current settings"
              disabled={!controller.commands.isEnabled('toolPresets.new')}
              onClick={() => controller.commands.run('toolPresets.new')}
            >
              <Icon name="newLayer" size={16} />
            </button>
          </div>
          <ToolPresetList currentOnly />
        </div>
      )}
    </div>
  );
}
