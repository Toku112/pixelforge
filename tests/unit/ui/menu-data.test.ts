import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYMAP } from '../../../src/app/keymap/defaults';
import { MENUS, visibleEntries, type MenuEntry } from '../../../src/ui/menus/menu-data';

function commands(entries: readonly MenuEntry[]): string[] {
  return entries.flatMap((e) => (e.kind === 'item' ? [e.command] : e.kind === 'submenu' ? commands(e.items) : []));
}

describe('menu bar data', () => {
  it('has the eleven top-level menus in order', () => {
    expect(MENUS.map((m) => m.label)).toEqual([
      'File',
      'Edit',
      'Image',
      'Layer',
      'Type',
      'Select',
      'Filter',
      'View',
      'Plugins',
      'Window',
      'Help',
    ]);
  });

  it('uses each command at most once', () => {
    const all = MENUS.flatMap((m) => commands(m.items));
    expect(all.length).toBe(new Set(all).size);
  });

  it('gives every default menu shortcut a home in the menus or the tools', () => {
    const inMenus = new Set(MENUS.flatMap((m) => commands(m.items)));
    const orphaned = DEFAULT_KEYMAP.map((b) => b.command).filter(
      (c) =>
        /^(file|edit|image|layer|select|filter)\./.test(c) &&
        !inMenus.has(c) &&
        c !== 'layer.newNoDialog' &&
        c !== 'layer.stampVisible' &&
        c !== 'select.feather',
    );
    expect(orphaned).toEqual([]);
  });

  it('hides unimplemented items, empty submenus and stray separators', () => {
    const registered = new Set(['file.open', 'file.saveAs', 'file.close']);
    const file = visibleEntries(MENUS[0]!.items, { isRegistered: (c) => registered.has(c), showUnimplemented: false });
    expect(file).toEqual([
      { kind: 'item', command: 'file.open', label: 'Open…' },
      { kind: 'separator' },
      { kind: 'item', command: 'file.close', label: 'Close' },
      { kind: 'separator' },
      { kind: 'item', command: 'file.saveAs', label: 'Save As…' },
    ]);
    const typeMenu = visibleEntries(MENUS[4]!.items, { isRegistered: () => false, showUnimplemented: false });
    expect(typeMenu).toEqual([]);
  });

  it('shows everything with the development flag', () => {
    const all = visibleEntries(MENUS[0]!.items, { isRegistered: () => false, showUnimplemented: true });
    expect(commands(all)).toEqual(commands(MENUS[0]!.items));
  });
});
