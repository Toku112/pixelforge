/**
 * Panel docking layout (pure, serialisable data; see DECISIONS D-005).
 *
 * Panels live in groups (one tab strip, one visible panel). Groups stack vertically
 * in dock columns on the right of the window; a column can be collapsed to an icon
 * strip. Groups can also float. Every operation returns a new layout.
 */

export type PanelId = string;

export interface PanelGroup {
  id: string;
  panels: PanelId[];
  active: PanelId;
  /** Relative height within its column. */
  weight: number;
}

export interface DockColumn {
  id: string;
  /** CSS pixels. */
  width: number;
  /** Shown as an icon strip; clicking an icon shows that panel in a pop-out. */
  collapsed: boolean;
  groups: PanelGroup[];
}

export interface FloatingGroup {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  group: PanelGroup;
}

export interface DockLayout {
  columns: DockColumn[];
  floating: FloatingGroup[];
}

export type DropTarget =
  /** Into an existing group's tab strip at `index`. */
  | { kind: 'group'; groupId: string; index: number }
  /** As a new group in a column at `index` (0 = top). */
  | { kind: 'new-group'; columnId: string; index: number }
  /** As a new floating group. */
  | { kind: 'float'; x: number; y: number };

export const MIN_COLUMN_WIDTH = 180;
export const MAX_COLUMN_WIDTH = 600;
export const MIN_GROUP_WEIGHT = 0.1;

let nextId = 1;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${nextId++}`;

function clone(layout: DockLayout): DockLayout {
  return structuredClone(layout);
}

function allGroups(layout: DockLayout): PanelGroup[] {
  return [...layout.columns.flatMap((c) => c.groups), ...layout.floating.map((f) => f.group)];
}

export function findPanel(layout: DockLayout, panel: PanelId): PanelGroup | undefined {
  return allGroups(layout).find((g) => g.panels.includes(panel));
}

export function isPanelOpen(layout: DockLayout, panel: PanelId): boolean {
  return !!findPanel(layout, panel);
}

/** Removes empty groups (and empty floating windows); keeps columns even when empty. */
function prune(layout: DockLayout): DockLayout {
  for (const column of layout.columns) column.groups = column.groups.filter((g) => g.panels.length > 0);
  layout.floating = layout.floating.filter((f) => f.group.panels.length > 0);
  return layout;
}

function detach(layout: DockLayout, panel: PanelId): void {
  const group = findPanel(layout, panel);
  if (!group) return;
  group.panels = group.panels.filter((p) => p !== panel);
  if (group.active === panel) group.active = group.panels[0] ?? '';
}

/** Moves (or opens) a panel to a drop target. */
export function movePanel(layout: DockLayout, panel: PanelId, target: DropTarget): DockLayout {
  const next = clone(layout);
  const source = findPanel(next, panel);
  // Dropping a group's only panel back into that group is a no-op.
  if (target.kind === 'group' && source?.id === target.groupId && source.panels.length === 1) return layout;
  let insertAt = target.kind === 'group' ? target.index : 0;
  if (target.kind === 'group' && source?.id === target.groupId) {
    const from = source.panels.indexOf(panel);
    if (from < insertAt) insertAt--;
  }
  detach(next, panel);

  if (target.kind === 'group') {
    const group = allGroups(next).find((g) => g.id === target.groupId);
    if (!group) throw new Error(`No panel group ${target.groupId}`);
    group.panels.splice(Math.max(0, Math.min(insertAt, group.panels.length)), 0, panel);
    group.active = panel;
  } else if (target.kind === 'new-group') {
    const column = next.columns.find((c) => c.id === target.columnId);
    if (!column) throw new Error(`No dock column ${target.columnId}`);
    const index = Math.max(0, Math.min(target.index, column.groups.length));
    column.groups.splice(index, 0, { id: newId('group'), panels: [panel], active: panel, weight: 1 });
  } else {
    next.floating.push({
      id: newId('float'),
      x: target.x,
      y: target.y,
      width: 260,
      height: 320,
      group: { id: newId('group'), panels: [panel], active: panel, weight: 1 },
    });
  }
  return prune(next);
}

export function closePanel(layout: DockLayout, panel: PanelId): DockLayout {
  const next = clone(layout);
  detach(next, panel);
  return prune(next);
}

export function closeGroup(layout: DockLayout, groupId: string): DockLayout {
  const next = clone(layout);
  const group = allGroups(next).find((g) => g.id === groupId);
  if (group) group.panels = [];
  return prune(next);
}

/** Shows a panel: activates it if open, otherwise adds it to the first column's first group (or floats it). */
export function openPanel(layout: DockLayout, panel: PanelId): DockLayout {
  const existing = findPanel(layout, panel);
  if (existing) return setActivePanel(layout, panel);
  const column = layout.columns[0];
  if (!column) return movePanel(layout, panel, { kind: 'float', x: 120, y: 120 });
  const first = column.groups[0];
  return first
    ? movePanel(layout, panel, { kind: 'group', groupId: first.id, index: first.panels.length })
    : movePanel(layout, panel, { kind: 'new-group', columnId: column.id, index: 0 });
}

export function togglePanel(layout: DockLayout, panel: PanelId): DockLayout {
  const group = findPanel(layout, panel);
  return group && group.active === panel ? closePanel(layout, panel) : openPanel(layout, panel);
}

export function setActivePanel(layout: DockLayout, panel: PanelId): DockLayout {
  const next = clone(layout);
  const group = findPanel(next, panel);
  if (group) group.active = panel;
  return next;
}

export function setColumnWidth(layout: DockLayout, columnId: string, width: number): DockLayout {
  const next = clone(layout);
  const column = next.columns.find((c) => c.id === columnId);
  if (column) column.width = Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));
  return next;
}

export function toggleColumnCollapsed(layout: DockLayout, columnId: string): DockLayout {
  const next = clone(layout);
  const column = next.columns.find((c) => c.id === columnId);
  if (column) column.collapsed = !column.collapsed;
  return next;
}

/**
 * Moves the boundary between group `index` and `index + 1` of a column by `delta`
 * (a fraction of the column's total weight), keeping both above the minimum.
 */
export function resizeGroups(layout: DockLayout, columnId: string, index: number, delta: number): DockLayout {
  const next = clone(layout);
  const column = next.columns.find((c) => c.id === columnId);
  const a = column?.groups[index];
  const b = column?.groups[index + 1];
  if (!column || !a || !b) return layout;
  const total = column.groups.reduce((s, g) => s + g.weight, 0);
  const d = delta * total;
  const clamped = Math.max(MIN_GROUP_WEIGHT - a.weight, Math.min(b.weight - MIN_GROUP_WEIGHT, d));
  a.weight += clamped;
  b.weight -= clamped;
  return next;
}

export function moveFloating(
  layout: DockLayout,
  floatId: string,
  x: number,
  y: number,
  bounds?: { width: number; height: number },
): DockLayout {
  const next = clone(layout);
  const f = next.floating.find((w) => w.id === floatId);
  if (!f) return layout;
  f.x = bounds ? Math.min(Math.max(0, x), Math.max(0, bounds.width - 60)) : x;
  f.y = bounds ? Math.min(Math.max(0, y), Math.max(0, bounds.height - 30)) : y;
  return next;
}

export function resizeFloating(layout: DockLayout, floatId: string, width: number, height: number): DockLayout {
  const next = clone(layout);
  const f = next.floating.find((w) => w.id === floatId);
  if (!f) return layout;
  f.width = Math.max(MIN_COLUMN_WIDTH, Math.round(width));
  f.height = Math.max(120, Math.round(height));
  return next;
}

/** Checks a stored layout and drops unknown panels; returns null if it is unusable. */
export function sanitizeLayout(value: unknown, knownPanels: ReadonlySet<string>): DockLayout | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<DockLayout>;
  if (!Array.isArray(v.columns) || !Array.isArray(v.floating)) return null;
  try {
    const layout = clone(v as DockLayout);
    const seen = new Set<string>();
    const fix = (g: PanelGroup) => {
      g.panels = g.panels.filter((p) => typeof p === 'string' && knownPanels.has(p) && !seen.has(p) && seen.add(p));
      if (!g.panels.includes(g.active)) g.active = g.panels[0] ?? '';
      if (!(g.weight > 0)) g.weight = 1;
    };
    for (const c of layout.columns) {
      if (typeof c.id !== 'string' || !Array.isArray(c.groups)) return null;
      c.width = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Number(c.width) || 260));
      c.collapsed = !!c.collapsed;
      c.groups.forEach(fix);
    }
    for (const f of layout.floating) fix(f.group);
    return prune(layout);
  } catch {
    return null;
  }
}
