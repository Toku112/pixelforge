/**
 * Placing a paint symmetry's guide (after choosing a type, or Transform Symmetry).
 * Not on the toolbar: the app switches to it and back.
 *
 * - Drag anywhere to move the guide; drag the round handle to turn it (Shift: 15°
 *   steps); drag the diamond to size it (circle radius, spiral turn spacing, wave
 *   length, parallel line spacing).
 * - Enter or the options bar's ✓ applies; Escape or ✗ cancels; choosing another
 *   tool applies.
 */
import type { Symmetry } from '../../core/paint/symmetry';
import type { CursorState, Tool, ToolContext, ToolPointerEvent } from '../types';

export interface SymmetryHost {
  /** The new placement (null: cancelled, or unchanged). */
  finish(symmetry: Symmetry | null): void;
}

type Handle = 'move' | 'rotate' | 'scale';

/** Distance of the turn handle from the centre, CSS pixels. */
const ROTATE_REACH = 70;
/** How near a handle a press must be, CSS pixels. */
const HIT = 9;

const DEG = Math.PI / 180;

/** Types whose size shows in the guide (and gets a size handle). */
const SIZED = new Set(['circle', 'spiral', 'wavy', 'parallel']);

export class SymmetryTool implements Tool {
  readonly id = 'symmetry';
  readonly name = 'Symmetry';
  readonly key = '';
  #session: { start: Symmetry; now: Symmetry; host: SymmetryHost } | null = null;
  #drag: { handle: Handle; from: { x: number; y: number }; start: Symmetry } | null = null;
  #hover: Handle | null = null;
  readonly #listeners = new Set<() => void>();

  get active(): boolean {
    return this.#session !== null;
  }

  /** Called when the tool starts or ends (the options bar shows ✓ and ✗ meanwhile). */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  begin(ctx: ToolContext, symmetry: Symmetry, host: SymmetryHost): void {
    this.#session = { start: symmetry, now: symmetry, host };
    this.#show(ctx);
  }

  cursor(state: CursorState): string {
    const h = this.#drag?.handle ?? this.#hover;
    if (state.dragging && h === 'move') return 'move';
    return h === 'rotate' || h === 'scale' ? 'grab' : 'move';
  }

  busy(): boolean {
    return this.#drag !== null;
  }

  /** Handle positions in document coordinates. */
  #handles(
    s: Symmetry,
    ctx: ToolContext,
  ): { rotate: { x: number; y: number }; scale: { x: number; y: number } | null } {
    const u = { x: Math.cos(s.angle * DEG), y: -Math.sin(s.angle * DEG) };
    const v = { x: Math.sin(s.angle * DEG), y: Math.cos(s.angle * DEG) };
    const reach = (ROTATE_REACH * ctx.devicePixelRatio) / ctx.viewport.zoom;
    const rotate = { x: s.cx + u.x * reach, y: s.cy + u.y * reach };
    if (!SIZED.has(s.kind)) return { rotate, scale: null };
    const scale =
      s.kind === 'parallel'
        ? { x: s.cx + (v.x * s.size) / 2, y: s.cy + (v.y * s.size) / 2 }
        : { x: s.cx - u.x * s.size, y: s.cy - u.y * s.size };
    return { rotate, scale };
  }

  #hitTest(e: ToolPointerEvent, ctx: ToolContext): Handle {
    const s = this.#session?.now;
    if (!s) return 'move';
    const h = this.#handles(s, ctx);
    const near = (p: { x: number; y: number }) => {
      const view = ctx.viewport.docToView(p);
      return Math.hypot(view.x - e.x, view.y - e.y) <= HIT * ctx.devicePixelRatio;
    };
    if (near(h.rotate)) return 'rotate';
    if (h.scale && near(h.scale)) return 'scale';
    return 'move';
  }

  onPointerHover(e: ToolPointerEvent, ctx: ToolContext): void {
    this.#hover = this.#session ? this.#hitTest(e, ctx) : null;
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    const s = this.#session;
    if (!s) return;
    this.#drag = { handle: this.#hitTest(e, ctx), from: ctx.viewport.viewToDoc(e), start: s.now };
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    const s = this.#session;
    const d = this.#drag;
    if (!s || !d) return;
    const p = ctx.viewport.viewToDoc(e);
    const a = d.start;
    let next: Symmetry;
    if (d.handle === 'move') {
      next = { ...a, cx: a.cx + p.x - d.from.x, cy: a.cy + p.y - d.from.y };
    } else if (d.handle === 'rotate') {
      // Counter-clockwise on screen (y down).
      const turn = Math.atan2(-(p.y - a.cy), p.x - a.cx) - Math.atan2(-(d.from.y - a.cy), d.from.x - a.cx);
      let angle = a.angle + turn / DEG;
      if (e.shiftKey) angle = Math.round(angle / 15) * 15;
      next = { ...a, angle: ((((angle + 180) % 360) + 360) % 360) - 180 };
    } else {
      const dx = p.x - a.cx;
      const dy = p.y - a.cy;
      const across = Math.abs(dx * Math.sin(a.angle * DEG) + dy * Math.cos(a.angle * DEG));
      const size = a.kind === 'parallel' ? 2 * across : Math.hypot(dx, dy);
      next = { ...a, size: Math.max(1, size) };
    }
    s.now = next;
    this.#show(ctx);
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!this.#drag) return;
    this.onPointerMove(e, ctx);
    this.#drag = null;
  }

  onKeyDown(key: string, ctx: ToolContext): boolean {
    if (!this.#session) return false;
    if (key === 'Enter') {
      if (!this.#drag) this.commit(ctx);
      return true;
    }
    if (key === 'Escape') {
      if (this.#drag) this.cancel(ctx);
      else this.abandon(ctx);
      return true;
    }
    return false;
  }

  /** Abandons a drag in progress. */
  cancel(ctx: ToolContext): void {
    const s = this.#session;
    const d = this.#drag;
    if (!s || !d) return;
    this.#drag = null;
    s.now = d.start;
    this.#show(ctx);
  }

  deactivate(ctx: ToolContext): void {
    if (this.#session) this.commit(ctx);
  }

  commit(ctx: ToolContext): void {
    const s = this.#session;
    if (!s) return;
    this.#end(ctx);
    const same = (Object.keys(s.start) as (keyof Symmetry)[]).every((k) => s.start[k] === s.now[k]);
    s.host.finish(same ? null : s.now);
  }

  abandon(ctx: ToolContext): void {
    const s = this.#session;
    if (!s) return;
    this.#end(ctx);
    s.host.finish(null);
  }

  #show(ctx: ToolContext): void {
    for (const listener of this.#listeners) listener();
    const s = this.#session;
    ctx.setSymmetryEdit(s ? { symmetry: s.now, ...this.#handles(s.now, ctx) } : null);
  }

  #end(ctx: ToolContext): void {
    this.#session = null;
    this.#drag = null;
    this.#hover = null;
    this.#show(ctx);
  }
}
