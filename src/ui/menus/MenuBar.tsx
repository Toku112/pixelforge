/**
 * The application menu bar. Click a menu to open it, then move along the bar by
 * hovering or with ←/→; ↑/↓ move through items, → opens a submenu, Enter runs,
 * Escape closes. Menus without any available command are shown dimmed.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { FLAGS, isFlagOn } from '../../app/flags';
import { useController, useWorkspace } from '../AppContext';
import { Icon } from '../icons';
import { MENUS, visibleEntries, type MenuEntry } from './menu-data';

interface RowModel {
  key: string;
  label: string;
  shortcut?: string;
  enabled: boolean;
  checked?: boolean;
  submenu?: RowModel[];
  run?: () => void;
}

function useMenuModel(): { id: string; label: string; rows: RowModel[] }[] {
  const controller = useController();
  const sessions = useWorkspace((w) => w.sessions.map((s) => ({ id: s.id, name: s.doc.name, active: s === w.active })));
  const showAll = isFlagOn(FLAGS.showUnimplementedMenuItems);
  const filter = { isRegistered: (c: string) => controller.commands.has(c), showUnimplemented: showAll };

  const toRows = (entries: MenuEntry[], prefix: string): RowModel[] =>
    entries.flatMap((entry, i): RowModel[] => {
      const key = `${prefix}-${i}`;
      if (entry.kind === 'separator') return [{ key, label: '-', enabled: false }];
      if (entry.kind === 'submenu') return [{ key, label: entry.label, enabled: true, submenu: toRows(entry.items, key) }];
      if (entry.kind === 'dynamic') {
        return sessions.map((s) => ({ key: `${key}-${s.id}`, label: s.name, enabled: true, checked: s.active, run: () => controller.workspace.activate(s.id) }));
      }
      const command = controller.commands.get(entry.command);
      return [
        {
          key,
          label: controller.labelFor(entry.command, entry.label),
          shortcut: controller.keymap.label(entry.command),
          enabled: !!command && controller.commands.isEnabled(entry.command),
          checked: command?.checked?.(),
          run: () => controller.commands.run(entry.command),
        },
      ];
    });

  return MENUS.map((menu) => ({ id: menu.id, label: menu.label, rows: toRows(visibleEntries(menu.items, filter), menu.id) }));
}

const selectable = (row: RowModel) => row.label !== '-' && (row.enabled || !!row.submenu);

export function MenuBar() {
  const menus = useMenuModel();
  const [open, setOpen] = useState<number | null>(null);
  const [active, setActive] = useState<number[]>([]); // highlighted row path, e.g. [3] or [3, 1]
  const barRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(null);
    setActive([]);
  }, []);

  useEffect(() => {
    if (open === null) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', close);
    };
  }, [open, close]);

  const activate = (row: RowModel) => {
    if (!row.enabled || !row.run) return;
    close();
    row.run();
  };

  const openMenu = (index: number) => {
    if (menus[index]!.rows.length === 0) return;
    setOpen(index);
    setActive([]);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (open === null) return;
    const rows = menus[open]!.rows;
    const level = active.length > 1 ? (rows[active[0]!]?.submenu ?? []) : rows;
    const current = active.at(-1) ?? -1;
    const step = (dir: 1 | -1) => {
      for (let i = 1; i <= level.length; i++) {
        const next = (current + dir * i + level.length) % level.length;
        if (selectable(level[next]!)) return next;
      }
      return current;
    };
    const moveMenu = (dir: 1 | -1) => {
      for (let i = 1; i <= menus.length; i++) {
        const next = (open + dir * i + menus.length) % menus.length;
        if (menus[next]!.rows.length > 0) return openMenu(next);
      }
    };
    switch (e.key) {
      case 'Escape':
        if (active.length > 1) setActive(active.slice(0, 1));
        else close();
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        const next = step(e.key === 'ArrowDown' ? 1 : -1);
        setActive(active.length === 0 ? [next] : [...active.slice(0, -1), next]);
        break;
      }
      case 'ArrowRight': {
        const row = active.length === 1 ? rows[active[0]!] : undefined;
        if (row?.submenu) setActive([active[0]!, row.submenu.findIndex(selectable)]);
        else moveMenu(1);
        break;
      }
      case 'ArrowLeft':
        if (active.length > 1) setActive(active.slice(0, 1));
        else moveMenu(-1);
        break;
      case 'Enter':
      case ' ': {
        const row = level[current];
        if (row?.submenu && active.length === 1) setActive([current, row.submenu.findIndex(selectable)]);
        else if (row) activate(row);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="menubar" role="menubar" aria-label="Application menu" ref={barRef} onKeyDown={onKeyDown}>
      {menus.map((menu, i) => {
        const empty = menu.rows.length === 0;
        return (
          <div key={menu.id} className="menubar-item">
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open === i}
              aria-disabled={empty}
              className={`menubar-button${open === i ? ' open' : ''}${empty ? ' empty' : ''}`}
              onClick={() => (open === i ? close() : openMenu(i))}
              onPointerEnter={() => open !== null && open !== i && openMenu(i)}
            >
              {menu.label}
            </button>
            {open === i && <MenuList rows={menu.rows} path={[]} active={active} setActive={setActive} activate={activate} label={menu.label} />}
          </div>
        );
      })}
    </div>
  );
}

function MenuList({ rows, path, active, setActive, activate, label }: { rows: RowModel[]; path: number[]; active: number[]; setActive: (p: number[]) => void; activate: (r: RowModel) => void; label: string }) {
  return (
    <div className={path.length ? 'menu submenu' : 'menu'} role="menu" aria-label={label}>
      {rows.map((row, i) => {
        if (row.label === '-') return <div key={row.key} className="menu-separator" role="separator" />;
        const here = [...path, i];
        const highlighted = active.length >= here.length && here.every((n, k) => active[k] === n);
        const role = row.checked !== undefined ? 'menuitemcheckbox' : 'menuitem';
        return (
          <div key={row.key} className="menu-row-wrap">
            <div
              role={role}
              aria-checked={row.checked}
              aria-disabled={!row.enabled}
              aria-haspopup={row.submenu ? 'menu' : undefined}
              tabIndex={-1}
              className={`menu-row${highlighted ? ' active' : ''}${row.enabled ? '' : ' disabled'}`}
              onPointerEnter={() => setActive(here)}
              onClick={() => (row.submenu ? setActive(here) : activate(row))}
            >
              <span className="menu-check">{row.checked && <Icon name="check" size={12} />}</span>
              <span className="menu-label">{row.label}</span>
              <span className="menu-shortcut">{row.submenu ? <Icon name="chevronRight" size={12} /> : row.shortcut}</span>
            </div>
            {row.submenu && highlighted && <MenuList rows={row.submenu} path={here} active={active} setActive={setActive} activate={activate} label={row.label} />}
          </div>
        );
      })}
    </div>
  );
}
