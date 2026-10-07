/**
 * Selection commands: Select All (Ctrl/Cmd+A), Deselect (Ctrl/Cmd+D), Reselect
 * (Shift+Ctrl/Cmd+D), Inverse (Shift+Ctrl/Cmd+I), the selection tools' shapes
 * (marquees and lassos, with new/add/subtract/intersect, feather and anti-alias)
 * and moving a selection outline. Each change is one history step, named after
 * the tool or command as in the reference app.
 *
 * Deselect remembers the selection for Reselect. A new shape that ends up
 * selecting nothing (e.g. drawn entirely outside the canvas) deselects.
 */
import type { ImageDocument } from '../../document/document';
import type { SelectionMode, SelectionShape } from '../../selection/mask-ops';
import { Selection } from '../../selection/selection';
import { CommandUnavailableError, type Command, type CommandContext, type JsonObject } from '../command';
import type { CommandDefinition } from '../registry';

/** History labels for the selection tools. */
export const SELECTION_TOOL_LABELS = {
  'rectangular-marquee': 'Rectangular Marquee',
  'elliptical-marquee': 'Elliptical Marquee',
  'single-row-marquee': 'Single Row Marquee',
  'single-column-marquee': 'Single Column Marquee',
  lasso: 'Lasso',
  'polygonal-lasso': 'Polygonal Lasso',
} as const;

export type SelectionTool = keyof typeof SELECTION_TOOL_LABELS;

interface SelectionState {
  selection: Selection | null;
  reselect: Selection | null;
}

const maskBytes = (s: Selection | null) => (s ? s.data.tiles.reduce((n, t) => n + t.data.byteLength, 0) : 0);

class SelectionCommand implements Command {
  readonly label: string;
  readonly descriptor: { name: string; params: JsonObject };
  readonly #ctx: CommandContext;
  readonly #compute: (doc: ImageDocument) => SelectionState | Promise<SelectionState>;
  #before: SelectionState | null = null;
  #after: SelectionState | null = null;

  constructor(
    ctx: CommandContext,
    label: string,
    descriptor: { name: string; params: JsonObject },
    compute: (doc: ImageDocument) => SelectionState | Promise<SelectionState>,
  ) {
    this.#ctx = ctx;
    this.label = label;
    this.descriptor = descriptor;
    this.#compute = compute;
  }

  get undoBytes(): number {
    return maskBytes(this.#after?.selection ?? null);
  }

  async execute(): Promise<void> {
    const after = await this.#compute(this.#ctx.doc);
    this.#after = after;
    this.#before = this.#ctx.doc.setSelection(after.selection, after.reselect);
  }

  undo(): void {
    this.#ctx.doc.setSelection(this.#before!.selection, this.#before!.reselect);
  }

  redo(): void {
    this.#ctx.doc.setSelection(this.#after!.selection, this.#after!.reselect);
  }
}

// ---------------------------------------------------------------------------
// Parameter parsing
// ---------------------------------------------------------------------------

const MODES: readonly SelectionMode[] = ['new', 'add', 'subtract', 'intersect'];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseShape(value: unknown): SelectionShape {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('selectShape: shape must be an object');
  const v = value as Record<string, unknown>;
  if (v['kind'] === 'rect' || v['kind'] === 'ellipse') {
    const { x, y, w, h } = v;
    if (!isNum(x) || !isNum(y) || !isNum(w) || !isNum(h) || w < 0 || h < 0)
      throw new Error('selectShape: rect and ellipse need x, y, w, h');
    return { kind: v['kind'], x, y, w, h };
  }
  if (v['kind'] === 'polygon') {
    const points = v['points'];
    if (!Array.isArray(points) || points.length < 6 || points.length % 2 !== 0 || !points.every(isNum))
      throw new Error('selectShape: polygon needs at least three x, y points');
    return { kind: 'polygon', points };
  }
  throw new Error('selectShape: unknown shape kind');
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const hasSelection = (ctx: CommandContext) => ctx.doc.selection !== null;

export const selectionCommands: CommandDefinition[] = [
  {
    name: 'selectShape',
    create: (ctx, p) => {
      const tool = p['tool'];
      if (typeof tool !== 'string' || !Object.hasOwn(SELECTION_TOOL_LABELS, tool))
        throw new Error('selectShape: unknown tool');
      const shape = parseShape(p['shape']);
      const mode = p['mode'] ?? 'new';
      if (!MODES.includes(mode as SelectionMode))
        throw new Error('selectShape: mode must be new, add, subtract or intersect');
      const feather = p['feather'] ?? 0;
      if (!isNum(feather) || feather < 0 || feather > 1000) throw new Error('selectShape: feather must be 0–1000 px');
      const antiAlias = p['antiAlias'] ?? true;
      if (typeof antiAlias !== 'boolean') throw new Error('selectShape: antiAlias must be true or false');
      const params: JsonObject = {
        tool,
        shape: shape,
        mode: mode,
        feather,
        antiAlias,
      };
      return new SelectionCommand(
        ctx,
        SELECTION_TOOL_LABELS[tool as SelectionTool],
        { name: 'selectShape', params },
        async (doc) => {
          const current = doc.selection;
          const mask = await ctx.services.pixelOps.selectShape(
            current?.data ?? null,
            shape,
            mode as SelectionMode,
            feather,
            antiAlias,
            doc.canvasRect,
          );
          // Selecting nothing deselects (and Reselect brings back what was there).
          if (!mask) return { selection: null, reselect: current ?? doc.reselectable };
          return { selection: new Selection(mask), reselect: doc.reselectable };
        },
      );
    },
  },
  {
    name: 'selectAll',
    create: (ctx) =>
      new SelectionCommand(ctx, 'Select All', { name: 'selectAll', params: {} }, (doc) => ({
        selection: Selection.all(),
        reselect: doc.reselectable,
      })),
  },
  {
    name: 'deselect',
    isAvailable: hasSelection,
    create: (ctx) =>
      new SelectionCommand(ctx, 'Deselect', { name: 'deselect', params: {} }, (doc) => {
        if (!doc.selection) throw new CommandUnavailableError('Nothing is selected');
        return { selection: null, reselect: doc.selection };
      }),
  },
  {
    name: 'reselect',
    isAvailable: (ctx) => ctx.doc.reselectable !== null,
    create: (ctx) =>
      new SelectionCommand(ctx, 'Reselect', { name: 'reselect', params: {} }, (doc) => {
        if (!doc.reselectable) throw new CommandUnavailableError('There is no selection to bring back');
        return { selection: doc.reselectable, reselect: doc.reselectable };
      }),
  },
  {
    name: 'inverseSelection',
    isAvailable: hasSelection,
    create: (ctx) =>
      new SelectionCommand(ctx, 'Inverse', { name: 'inverseSelection', params: {} }, async (doc) => {
        if (!doc.selection) throw new CommandUnavailableError('Nothing is selected');
        const mask = await ctx.services.pixelOps.invertSelection(doc.selection.data, doc.canvasRect);
        return { selection: mask ? new Selection(mask) : null, reselect: doc.reselectable };
      }),
  },
  {
    name: 'moveSelection',
    isAvailable: hasSelection,
    create: (ctx, p) => {
      const dx = p['dx'];
      const dy = p['dy'];
      if (!Number.isInteger(dx) || !Number.isInteger(dy))
        throw new Error('moveSelection: dx and dy must be whole pixels');
      return new SelectionCommand(
        ctx,
        'Move Selection',
        { name: 'moveSelection', params: { dx, dy } as JsonObject },
        (doc) => {
          if (!doc.selection) throw new CommandUnavailableError('Nothing is selected');
          return { selection: doc.selection.moved(dx as number, dy as number), reselect: doc.reselectable };
        },
      );
    },
  },
];
