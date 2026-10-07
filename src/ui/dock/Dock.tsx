/**
 * Panel docks (right side) and floating panel windows.
 *
 * - Drag a panel tab onto another tab strip to group it, onto the top/bottom edge
 *   of a panel group to stack it as a new group, or anywhere else to float it.
 * - Drag the splitter between groups to resize them; drag a column's left edge to
 *   change its width; the column header button collapses it to icons.
 * - Floating windows move by their grip bar and resize from the corner.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useController } from '../AppContext';
import { Icon } from '../icons';
import { PANELS } from '../panels/panel-registry';
import { useUi } from '../state/ui-store';
import {
  closeGroup,
  closePanel,
  moveFloating,
  movePanel,
  resizeFloating,
  resizeGroups,
  setActivePanel,
  setColumnWidth,
  toggleColumnCollapsed,
  type DockColumn,
  type DropTarget,
  type PanelGroup,
} from './dock-model';

interface DragState {
  panel: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  target: DropTarget | null;
  indicator: { left: number; top: number; width: number; height: number } | null;
}

const DRAG_THRESHOLD = 5;

/** Finds where a dragged panel would land under the pointer. */
function hitTest(x: number, y: number): { target: DropTarget; indicator: DragState['indicator'] } {
  const el = document.elementFromPoint(x, y);
  const strip = el?.closest<HTMLElement>('[data-dock-tabstrip]');
  if (strip) {
    const tabs = [...strip.querySelectorAll<HTMLElement>('[data-dock-tab]')];
    let index = tabs.length;
    for (const [i, tab] of tabs.entries()) {
      const r = tab.getBoundingClientRect();
      if (x < r.left + r.width / 2) {
        index = i;
        break;
      }
    }
    const r = strip.getBoundingClientRect();
    return {
      target: { kind: 'group', groupId: strip.dataset['dockTabstrip']!, index },
      indicator: { left: r.left, top: r.top, width: r.width, height: r.height },
    };
  }
  const body = el?.closest<HTMLElement>('[data-dock-group-body]');
  if (body?.dataset['column']) {
    const r = body.getBoundingClientRect();
    const index = Number(body.dataset['groupIndex']);
    const column = body.dataset['column'];
    if (y < r.top + r.height * 0.3)
      return {
        target: { kind: 'new-group', columnId: column, index },
        indicator: { left: r.left, top: r.top - 2, width: r.width, height: 4 },
      };
    if (y > r.bottom - r.height * 0.3)
      return {
        target: { kind: 'new-group', columnId: column, index: index + 1 },
        indicator: { left: r.left, top: r.bottom - 2, width: r.width, height: 4 },
      };
    return {
      target: { kind: 'group', groupId: body.dataset['dockGroupBody']!, index: Infinity },
      indicator: { left: r.left, top: r.top, width: r.width, height: r.height },
    };
  }
  const column = el?.closest<HTMLElement>('[data-dock-column]');
  if (column) {
    const r = column.getBoundingClientRect();
    return {
      target: { kind: 'new-group', columnId: column.dataset['dockColumn']!, index: Infinity },
      indicator: { left: r.left, top: r.bottom - 4, width: r.width, height: 4 },
    };
  }
  return { target: { kind: 'float', x: x - 40, y: y - 12 }, indicator: null };
}

function useTabDrag() {
  const [drag, setDragState] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const setDrag = useCallback((next: DragState | null) => {
    dragRef.current = next;
    setDragState(next);
  }, []);
  const dragging = drag !== null;

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const active = d.active || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > DRAG_THRESHOLD;
      const hit = active ? hitTest(e.clientX, e.clientY) : null;
      setDrag({
        ...d,
        x: e.clientX,
        y: e.clientY,
        active,
        target: hit?.target ?? null,
        indicator: hit?.indicator ?? null,
      });
    };
    const up = () => {
      const d = dragRef.current;
      if (d?.active && d.target) {
        const ui = useUi.getState();
        ui.setDock(movePanel(ui.dock, d.panel, d.target));
      }
      setDrag(null);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
    };
  }, [dragging, setDrag]);

  const start = (panel: string, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    setDrag({
      panel,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      active: false,
      target: null,
      indicator: null,
    });
  };
  return { drag, start };
}

type StartDrag = (panel: string, e: ReactPointerEvent) => void;

function PanelMenu({ group, onClose }: { group: PanelGroup; onClose: () => void }) {
  const controller = useController();
  const def = PANELS[group.active];
  const setDock = useUi((s) => s.setDock);
  const dock = useUi((s) => s.dock);
  return (
    <div className="menu panel-menu" role="menu" onPointerLeave={onClose}>
      {def?.menu?.map((m) => (
        <div
          key={m.command}
          role="menuitem"
          tabIndex={-1}
          aria-disabled={!controller.commands.isEnabled(m.command)}
          className={`menu-row${controller.commands.isEnabled(m.command) ? '' : ' disabled'}`}
          onClick={() => {
            controller.commands.run(m.command);
            onClose();
          }}
        >
          <span className="menu-check" />
          <span className="menu-label">{controller.labelFor(m.command, m.label)}</span>
          <span className="menu-shortcut">{controller.keymap.label(m.command)}</span>
        </div>
      ))}
      {def?.menu && <div className="menu-separator" role="separator" />}
      <div
        role="menuitem"
        tabIndex={-1}
        className="menu-row"
        onClick={() => (setDock(closePanel(dock, group.active)), onClose())}
      >
        <span className="menu-check" />
        <span className="menu-label">Close</span>
      </div>
      <div
        role="menuitem"
        tabIndex={-1}
        className="menu-row"
        onClick={() => (setDock(closeGroup(dock, group.id)), onClose())}
      >
        <span className="menu-check" />
        <span className="menu-label">Close Tab Group</span>
      </div>
    </div>
  );
}

function GroupView({
  group,
  column,
  index,
  startDrag,
  weight,
}: {
  group: PanelGroup;
  column?: string;
  index?: number;
  startDrag: StartDrag;
  weight?: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const setDock = useUi((s) => s.setDock);
  const Active = PANELS[group.active]?.component;
  return (
    <section
      className="panel-group"
      style={weight !== undefined ? { flexGrow: weight } : undefined}
      aria-label={PANELS[group.active]?.title}
    >
      <div className="panel-tabs" data-dock-tabstrip={group.id} role="tablist">
        {group.panels.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === group.active}
            className={`panel-tab${id === group.active ? ' active' : ''}`}
            data-dock-tab={id}
            onPointerDown={(e) => startDrag(id, e)}
            onClick={() => setDock(setActivePanel(useUi.getState().dock, id))}
          >
            {PANELS[id]?.title ?? id}
          </button>
        ))}
        <span className="panel-tabs-spacer" />
        <button
          type="button"
          className="panel-menu-button"
          aria-label="Panel menu"
          aria-haspopup="menu"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <Icon name="menu" size={14} />
        </button>
        {menuOpen && <PanelMenu group={group} onClose={() => setMenuOpen(false)} />}
      </div>
      <div className="panel-body" data-dock-group-body={group.id} data-column={column} data-group-index={index}>
        {Active && <Active />}
      </div>
    </section>
  );
}

function Splitter({ column, index }: { column: DockColumn; index: number }) {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const columnEl = e.currentTarget.closest<HTMLElement>('[data-dock-column]');
    if (!columnEl) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    let lastY = e.clientY;
    const height = columnEl.getBoundingClientRect().height;
    const move = (ev: PointerEvent) => {
      const ui = useUi.getState();
      ui.setDock(resizeGroups(ui.dock, column.id, index, (ev.clientY - lastY) / height));
      lastY = ev.clientY;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div className="dock-splitter" role="separator" aria-orientation="horizontal" onPointerDown={onPointerDown} />;
}

function ColumnView({ column, startDrag }: { column: DockColumn; startDrag: StartDrag }) {
  const setDock = useUi((s) => s.setDock);
  const [popout, setPopout] = useState<string | null>(null);

  const onResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = column.width;
    const move = (ev: PointerEvent) => {
      const ui = useUi.getState();
      ui.setDock(setColumnWidth(ui.dock, column.id, startWidth + (startX - ev.clientX)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const header = (
    <div className="dock-column-header">
      <button
        type="button"
        className="dock-collapse"
        aria-label={column.collapsed ? 'Expand panels' : 'Collapse to icons'}
        title={column.collapsed ? 'Expand Panels' : 'Collapse to Icons'}
        onClick={() => setDock(toggleColumnCollapsed(useUi.getState().dock, column.id))}
      >
        <Icon name={column.collapsed ? 'expand' : 'collapse'} size={12} />
      </button>
    </div>
  );

  if (column.collapsed) {
    const panels = column.groups.flatMap((g) => g.panels);
    const Pop = popout ? PANELS[popout]?.component : undefined;
    return (
      <aside className="dock-column collapsed" data-dock-column={column.id} aria-label="Panels">
        {header}
        {panels.map((id) => (
          <button
            key={id}
            type="button"
            className={`dock-icon${popout === id ? ' active' : ''}`}
            aria-label={PANELS[id]?.title}
            title={PANELS[id]?.title}
            onClick={() => setPopout(popout === id ? null : id)}
          >
            <Icon name={PANELS[id]?.icon ?? 'menu'} size={16} />
          </button>
        ))}
        {Pop && (
          <div className="dock-popout" role="dialog" aria-label={PANELS[popout!]?.title}>
            <div className="dock-popout-title">{PANELS[popout!]?.title}</div>
            <div className="panel-body">
              <Pop />
            </div>
          </div>
        )}
      </aside>
    );
  }

  return (
    <aside className="dock-column" data-dock-column={column.id} style={{ width: column.width }} aria-label="Panels">
      <div className="dock-resize" role="separator" aria-orientation="vertical" onPointerDown={onResize} />
      {header}
      <div className="dock-groups">
        {column.groups.map((group, i) => (
          <div key={group.id} className="dock-group-wrap" style={{ flexGrow: group.weight }}>
            {i > 0 && <Splitter column={column} index={i - 1} />}
            <GroupView group={group} column={column.id} index={i} startDrag={startDrag} />
          </div>
        ))}
      </div>
    </aside>
  );
}

function FloatingWindow({
  id,
  x,
  y,
  width,
  height,
  group,
  startDrag,
}: {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  group: PanelGroup;
  startDrag: StartDrag;
}) {
  const drag = (kind: 'move' | 'resize') => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: PointerEvent) => {
      const ui = useUi.getState();
      const bounds = { width: window.innerWidth, height: window.innerHeight };
      ui.setDock(
        kind === 'move'
          ? moveFloating(ui.dock, id, x + ev.clientX - sx, y + ev.clientY - sy, bounds)
          : resizeFloating(ui.dock, id, width + ev.clientX - sx, height + ev.clientY - sy),
      );
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="floating-panel" style={{ left: x, top: y, width, height }} data-floating={id}>
      <div className="floating-grip" onPointerDown={drag('move')} aria-label="Move panel" />
      <GroupView group={group} startDrag={startDrag} />
      <div className="floating-resize" onPointerDown={drag('resize')} aria-label="Resize panel" />
    </div>
  );
}

export function Docks() {
  const dock = useUi((s) => s.dock);
  const { drag, start } = useTabDrag();
  return (
    <>
      <div className="docks">
        {dock.columns.map((column) => (
          <ColumnView key={column.id} column={column} startDrag={start} />
        ))}
      </div>
      {dock.floating.map((f) => (
        <FloatingWindow key={f.id} {...f} startDrag={start} />
      ))}
      {drag?.active && (
        <>
          {drag.indicator && <div className="dock-drop-indicator" style={drag.indicator} />}
          <div className="dock-drag-ghost" style={{ left: drag.x + 8, top: drag.y + 8 }}>
            {PANELS[drag.panel]?.title}
          </div>
        </>
      )}
    </>
  );
}
