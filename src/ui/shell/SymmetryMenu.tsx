/**
 * The options bar's paint symmetry menu (the butterfly): the types, then Transform,
 * Hide and Turn Off Symmetry. While a guide is being placed, ✓ and ✗ instead.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import { SYMMETRY_KINDS } from '../../core/paint/symmetry';
import type { SymmetryTool } from '../../tools/symmetry/symmetry-tool';
import { useController, useWorkspace } from '../AppContext';
import { Icon } from '../icons';
import { useUi } from '../state/ui-store';

const ACTIONS = ['symmetry.transform', 'symmetry.hide', 'symmetry.off'] as const;

export function SymmetryMenu() {
  const controller = useController();
  useUi((s) => s.toolOptionsVersion);
  // Redraw when the document (and its symmetry) changes.
  useWorkspace((w) => w.active?.doc.symmetry);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const commands = controller.commands;
  const symmetry = controller.workspace.active?.doc.symmetry;
  const on = symmetry?.enabled === true;

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  const run = (id: string) => {
    setOpen(false);
    commands.run(id);
  };
  const item = (id: string) => {
    const command = commands.get(id);
    if (!command) return null;
    const enabled = commands.isEnabled(id);
    const checked = command.checked?.() ?? false;
    return (
      <button
        key={id}
        type="button"
        role="menuitemcheckbox"
        aria-checked={checked}
        disabled={!enabled}
        className="symmetry-item"
        onClick={() => run(id)}
      >
        <span className="menu-check">{checked ? '✓' : ''}</span>
        {command.label}
      </button>
    );
  };

  return (
    <div className="symmetry-menu" ref={root}>
      <button
        type="button"
        className={`option-icon${on ? ' active' : ''}`}
        aria-label="Paint symmetry"
        aria-haspopup="menu"
        aria-expanded={open}
        title={on ? `Paint symmetry: ${SYMMETRY_KINDS.find((k) => k[0] === symmetry.kind)?.[1]}` : 'Paint symmetry'}
        onClick={() => setOpen(!open)}
      >
        <Icon name="symmetry" size={16} />
      </button>
      {open && (
        <div className="brush-picker-panel symmetry-panel" role="menu" aria-label="Paint symmetry">
          {SYMMETRY_KINDS.map(([kind]) => item(`symmetry.${kind}`))}
          <div className="menu-separator" role="separator" />
          {ACTIONS.map((id) => item(id))}
        </div>
      )}
    </div>
  );
}

/** While a symmetry guide is placed: cancel and apply. */
export function SymmetryOptions({ tool }: { tool: SymmetryTool }) {
  const controller = useController();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => tool.onChange(redraw), [tool]);
  const act = (fn: (ctx: NonNullable<typeof controller.canvas>['context']) => void) => () => {
    const ctx = controller.canvas?.context;
    if (ctx) fn(ctx);
  };
  if (!tool.active) return null;
  return (
    <>
      <span className="hint">Drag to move the guide, the round handle to turn it, the diamond to size it.</span>
      <span className="options-divider" />
      <button
        type="button"
        className="option-icon"
        aria-label="Cancel symmetry placement"
        title="Cancel (Esc)"
        onClick={act((c) => tool.abandon(c))}
      >
        <Icon name="cancelCircle" size={16} />
      </button>
      <button
        type="button"
        className="option-icon"
        aria-label="Apply symmetry placement"
        title="Apply (Enter)"
        onClick={act((c) => tool.commit(c))}
      >
        <Icon name="check" size={16} />
      </button>
    </>
  );
}
