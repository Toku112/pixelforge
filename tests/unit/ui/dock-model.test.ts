import { describe, expect, it } from 'vitest';
import {
  closeGroup,
  closePanel,
  findPanel,
  isPanelOpen,
  movePanel,
  openPanel,
  resizeGroups,
  sanitizeLayout,
  setColumnWidth,
  toggleColumnCollapsed,
  togglePanel,
  type DockLayout,
} from '../../../src/ui/dock/dock-model';
import { essentialsLayout } from '../../../src/ui/dock/workspaces';

const panelsOf = (layout: DockLayout) => layout.columns.map((c) => c.groups.map((g) => g.panels));

/** A fixed layout for the layout operations (independent of the default workspace). */
function twoPanels(): DockLayout {
  return {
    columns: [
      {
        id: 'main',
        width: 260,
        collapsed: false,
        groups: [
          { id: 'g-navigator', panels: ['navigator'], active: 'navigator', weight: 1 },
          { id: 'g-history', panels: ['history'], active: 'history', weight: 1.4 },
        ],
      },
    ],
    floating: [],
  };
}

describe('dock model', () => {
  it('starts from the Essentials layout', () => {
    expect(panelsOf(essentialsLayout())).toEqual([[['navigator'], ['history'], ['layers']]]);
  });

  it('moves a panel into another group as a tab, activating it', () => {
    const l = movePanel(twoPanels(), 'history', { kind: 'group', groupId: 'g-navigator', index: 1 });
    expect(panelsOf(l)).toEqual([[['navigator', 'history']]]); // the emptied group disappears
    expect(findPanel(l, 'history')?.active).toBe('history');
  });

  it('reorders tabs within a group', () => {
    let l = movePanel(twoPanels(), 'history', { kind: 'group', groupId: 'g-navigator', index: 1 });
    l = movePanel(l, 'navigator', { kind: 'group', groupId: 'g-navigator', index: 2 });
    expect(panelsOf(l)).toEqual([[['history', 'navigator']]]);
  });

  it('creates a new group in a column', () => {
    let l = movePanel(twoPanels(), 'history', { kind: 'group', groupId: 'g-navigator', index: 1 });
    l = movePanel(l, 'history', { kind: 'new-group', columnId: 'main', index: 0 });
    expect(panelsOf(l)).toEqual([[['history'], ['navigator']]]);
  });

  it('floats a panel and docks it again', () => {
    let l = movePanel(twoPanels(), 'navigator', { kind: 'float', x: 50, y: 60 });
    expect(l.floating).toHaveLength(1);
    expect(l.floating[0]).toMatchObject({ x: 50, y: 60, group: { panels: ['navigator'] } });
    l = movePanel(l, 'navigator', { kind: 'new-group', columnId: 'main', index: 0 });
    expect(l.floating).toHaveLength(0);
    expect(panelsOf(l)).toEqual([[['navigator'], ['history']]]);
  });

  it('closes, opens and toggles panels', () => {
    let l = closePanel(twoPanels(), 'history');
    expect(isPanelOpen(l, 'history')).toBe(false);
    l = openPanel(l, 'history');
    expect(panelsOf(l)).toEqual([[['navigator', 'history']]]);
    l = togglePanel(l, 'history'); // active → closes
    expect(isPanelOpen(l, 'history')).toBe(false);
    l = closeGroup(twoPanels(), 'g-navigator');
    expect(panelsOf(l)).toEqual([[['history']]]);
  });

  it('opens a panel floating when there is no column', () => {
    const l = openPanel({ columns: [], floating: [] }, 'history');
    expect(l.floating[0]?.group.panels).toEqual(['history']);
  });

  it('resizes columns and groups within limits, and collapses to icons', () => {
    let l = setColumnWidth(twoPanels(), 'main', 5000);
    expect(l.columns[0]!.width).toBe(600);
    l = setColumnWidth(l, 'main', 10);
    expect(l.columns[0]!.width).toBe(180);
    l = resizeGroups(twoPanels(), 'main', 0, 0.2);
    const [a, b] = l.columns[0]!.groups;
    expect(a!.weight).toBeCloseTo(1 + 0.2 * 2.4);
    expect(b!.weight).toBeCloseTo(1.4 - 0.2 * 2.4);
    l = resizeGroups(twoPanels(), 'main', 0, -5); // clamped
    expect(l.columns[0]!.groups[0]!.weight).toBeCloseTo(0.1);
    expect(toggleColumnCollapsed(twoPanels(), 'main').columns[0]!.collapsed).toBe(true);
  });

  it('never mutates the input layout', () => {
    const original = twoPanels();
    const snapshot = structuredClone(original);
    movePanel(original, 'history', { kind: 'float', x: 0, y: 0 });
    closePanel(original, 'navigator');
    expect(original).toEqual(snapshot);
  });

  it('sanitises stored layouts', () => {
    const known = new Set(['history', 'navigator']);
    expect(sanitizeLayout('nonsense', known)).toBeNull();
    const stored = {
      columns: [
        {
          id: 'main',
          width: 99999,
          collapsed: 0,
          groups: [{ id: 'g', panels: ['history', 'ghost', 'history'], active: 'ghost', weight: -1 }],
        },
      ],
      floating: [],
    };
    expect(sanitizeLayout(stored, known)).toEqual({
      columns: [
        {
          id: 'main',
          width: 600,
          collapsed: false,
          groups: [{ id: 'g', panels: ['history'], active: 'history', weight: 1 }],
        },
      ],
      floating: [],
    });
  });
});
