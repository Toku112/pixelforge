/**
 * The toolbar: one button per tool group, showing the group's current tool.
 * Long-press or right-click a group with several tools to choose another one.
 * Double-click the Hand tool to fit the image on screen, the Zoom tool for 100 %.
 */
import { useRef, useState } from 'react';
import { viewActions } from '../../tools/hand/hand-tool';
import { useController } from '../AppContext';
import { Icon, type IconName } from '../icons';
import { useUi } from '../state/ui-store';

const TOOL_ICONS: Record<string, IconName> = { hand: 'hand', 'rotate-view': 'rotateView', zoom: 'zoom' };
const LONG_PRESS_MS = 450;

export function Toolbar() {
  const controller = useController();
  const activeToolId = useUi((s) => s.activeToolId);
  const groupTool = useUi((s) => s.groupTool);
  const setActiveTool = useUi((s) => s.setActiveTool);
  const [flyout, setFlyout] = useState<string | null>(null);
  const pressTimer = useRef<number | null>(null);

  const select = (toolId: string, groupId: string) => {
    setActiveTool(toolId, groupId);
    setFlyout(null);
  };

  return (
    <nav className="toolbar" aria-label="Tools">
      {controller.tools.groups.map((group) => {
        const current =
          group.tools.find((t) => t.id === activeToolId) ??
          group.tools.find((t) => t.id === groupTool[group.id]) ??
          group.tools[0]!;
        const active = group.tools.some((t) => t.id === activeToolId);
        const multiple = group.tools.length > 1;
        return (
          <div key={group.id} className="tool-group">
            <button
              type="button"
              className={`tool-button${active ? ' active' : ''}`}
              aria-pressed={active}
              aria-label={current.name}
              title={`${current.name} (${current.key})`}
              data-tool={current.id}
              onClick={() => select(current.id, group.id)}
              onDoubleClick={() => {
                const ctx = controller.canvas?.context;
                if (!ctx) return;
                if (current.id === 'hand') viewActions.fitOnScreen(ctx);
                if (current.id === 'zoom') viewActions.actualPixels(ctx);
              }}
              onContextMenu={(e) => {
                if (!multiple) return;
                e.preventDefault();
                setFlyout(group.id);
              }}
              onPointerDown={() => {
                if (multiple) pressTimer.current = window.setTimeout(() => setFlyout(group.id), LONG_PRESS_MS);
              }}
              onPointerUp={() => pressTimer.current !== null && window.clearTimeout(pressTimer.current)}
              onPointerLeave={() => pressTimer.current !== null && window.clearTimeout(pressTimer.current)}
            >
              <Icon name={TOOL_ICONS[current.id] ?? 'hand'} size={20} />
              {multiple && <span className="tool-group-mark" aria-hidden="true" />}
            </button>
            {flyout === group.id && (
              <div className="tool-flyout" role="menu" aria-label="Tool group" onPointerLeave={() => setFlyout(null)}>
                {group.tools.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={tool.id === current.id}
                    className="tool-flyout-row"
                    onClick={() => select(tool.id, group.id)}
                  >
                    <Icon name={TOOL_ICONS[tool.id] ?? 'hand'} size={16} />
                    <span>{tool.name}</span>
                    <span className="menu-shortcut">{tool.key}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
