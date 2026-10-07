/**
 * Free Transform (Edit > Free Transform, Ctrl/Cmd+T): a box with handles around the
 * selected layers or the selection; the app switches to this tool while it is open.
 *
 * Behaviour (own summary of the reference app):
 * - Corner and side handles scale, keeping the proportions by default (the link
 *   button in the options bar; Shift does the opposite). Alt/Option scales about the
 *   reference point (the centre unless moved).
 * - Dragging outside the box rotates about the reference point (Shift: 15° steps);
 *   inside moves (Shift: horizontally or vertically only).
 * - Ctrl/Cmd + corner distorts (the corner moves freely); Ctrl/Cmd + side skews (the
 *   side moves; with Alt the opposite side moves the other way); Ctrl/Cmd+Alt+Shift
 *   + corner sets perspective (the corner and its neighbour move apart symmetrically).
 * - The options bar shows the reference point and the numbers (position, width and
 *   height %, angle, skews), which can be typed; it also picks the interpolation.
 * - Enter (or ✓) applies, Escape (or ⊘) cancels. The result shows live while editing.
 */
import type { CommandDescriptor } from '../../core/commands/command';
import type { Rect } from '../../core/document/geometry';
import type { ResampleMethod } from '../../core/geometry/layer-geometry';
import {
  IDENTITY,
  about,
  affineFromParts,
  affineParts,
  apply,
  invert,
  isValidQuad,
  multiply,
  quadOf,
  rectToQuad,
  rotation,
  scaling,
  translation,
  type AffineParts,
  type Mat3,
  type Point,
  type Quad,
} from '../../core/geometry/transform';
import type { CursorState, Tool, ToolContext, ToolPointerEvent } from '../types';

export interface TransformOptions {
  interpolation: ResampleMethod;
  /** Scale keeping the proportions (Shift does the opposite while dragging). */
  keepRatio: boolean;
  showReference: boolean;
}

/** Handles: corners 0–3 (top-left, top-right, bottom-right, bottom-left), sides 4–7 (top, right, bottom, left). */
export type TransformHandle = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
type Hit =
  { kind: 'handle'; handle: TransformHandle } | { kind: 'reference' } | { kind: 'inside' } | { kind: 'outside' };

/** Fractions of the box for each handle. */
const HANDLE_AT: readonly [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0.5, 0],
  [1, 0.5],
  [0.5, 1],
  [0, 0.5],
];
/** Each side's corners. */
const SIDE_CORNERS: readonly [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
];
/** Handle grab distance, CSS pixels. */
const GRAB = 6;
const DEG = 180 / Math.PI;

/** A curved double arrow (our own drawing) for rotating. */
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">' +
    '<path d="M5 15a8 8 0 0 1 14 0" stroke="#fff" stroke-width="4"/><path d="M5 15a8 8 0 0 1 14 0" stroke="#000" stroke-width="1.6"/>' +
    '<path d="M2 12l3 4 3-4zM16 12l3 4 3-4z" fill="#000" stroke="#fff" stroke-width="1"/></svg>',
)}") 12 12, crosshair`;

interface Session {
  /** The original box (document pixels). */
  bounds: Rect;
  quad: Quad;
  reference: Point;
  /** Vertical skew as typed (it cannot be read back from the shape). */
  skewV: number;
  host: TransformHost;
}

/** How the app shows and records a transform. */
export interface TransformHost {
  /** Show the transform live; `draft`: the visible area and a sample spacing for quick previews. */
  preview(matrix: Mat3, draft: Rect & { step: number }): void;
  /** Called once: with the command to record when applied, null when cancelled (or unchanged). */
  finish(descriptor: CommandDescriptor | null): void;
}

interface Drag {
  hit: Hit;
  start: Point;
  quad: Quad;
  reference: Point;
  matrix: Mat3;
  inverse: Mat3;
  mode: 'scale' | 'rotate' | 'move' | 'distort' | 'skew' | 'perspective' | 'reference';
}

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });

export class TransformTool implements Tool {
  readonly id = 'transform';
  readonly name = 'Free Transform';
  readonly key = '';
  options: TransformOptions = { interpolation: 'automatic', keepRatio: true, showReference: false };
  #session: Session | null = null;
  #drag: Drag | null = null;
  #hover: Hit | null = null;
  readonly #listeners = new Set<() => void>();

  /** Calls `listener` whenever the box changes (for the options-bar numbers); returns an unsubscribe. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get active(): boolean {
    return this.#session !== null;
  }

  /** The transform so far (document coordinates), or null when not transforming. */
  get matrix(): Mat3 | null {
    const s = this.#session;
    return s ? (rectToQuad(s.bounds, s.quad) ?? IDENTITY) : null;
  }

  get quad(): Quad | null {
    return this.#session?.quad ?? null;
  }

  get reference(): Point | null {
    return this.#session?.reference ?? null;
  }

  /** The options-bar numbers: scale (1 = 100 %), angle and skews in degrees. */
  get parts(): AffineParts | null {
    const s = this.#session;
    return s ? affineParts(s.quad, s.bounds, s.skewV) : null;
  }

  /** Opens the box around `bounds` (document pixels); `host` shows and records the result. */
  begin(ctx: ToolContext, bounds: Rect, host: TransformHost): void {
    this.#session = {
      bounds,
      quad: quadOf(IDENTITY, bounds),
      reference: { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
      skewV: 0,
      host,
    };
    this.#drag = null;
    this.#show(ctx);
  }

  cursor(state: CursorState): string {
    const hit = this.#drag?.hit ?? this.#hover;
    if (!hit || !this.#session) return 'default';
    if (hit.kind === 'outside') return ROTATE_CURSOR;
    if (hit.kind === 'inside') return state.dragging ? 'move' : 'default';
    if (hit.kind === 'reference') return 'move';
    if (this.#drag?.mode === 'distort' || this.#drag?.mode === 'skew' || this.#drag?.mode === 'perspective')
      return 'default';
    // A resize cursor along the handle's direction from the centre (on screen the box may be turned).
    const q = this.#session.quad;
    const centre = lerp(q[0], q[2], 0.5);
    const h = this.#handlePoint(hit.handle);
    const angle = ((Math.atan2(h.y - centre.y, h.x - centre.x) * DEG + 360) % 180) / 45;
    return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(angle) % 4]!;
  }

  busy(): boolean {
    return this.#session !== null;
  }

  onPointerHover(e: ToolPointerEvent, ctx: ToolContext): void {
    this.#hover = this.#hitTest(e, ctx);
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    const s = this.#session;
    if (!s) return;
    const hit = this.#hitTest(e, ctx);
    const matrix = this.matrix!;
    const inverse = invert(matrix) ?? IDENTITY;
    let mode: Drag['mode'];
    if (hit.kind === 'reference') mode = 'reference';
    else if (hit.kind === 'inside') mode = 'move';
    else if (hit.kind === 'outside') mode = 'rotate';
    else if (e.primaryKey) mode = hit.handle < 4 ? (e.altKey && e.shiftKey ? 'perspective' : 'distort') : 'skew';
    else mode = 'scale';
    this.#drag = {
      hit,
      start: ctx.viewport.viewToDoc(e),
      quad: s.quad,
      reference: s.reference,
      matrix,
      inverse,
      mode,
    };
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    const s = this.#session;
    const d = this.#drag;
    if (!s || !d) return;
    const p = ctx.viewport.viewToDoc(e);
    const delta = sub(p, d.start);
    let quad: Quad | null = null;
    let reference = d.reference;
    switch (d.mode) {
      case 'reference':
        reference = p;
        break;
      case 'move': {
        let dx = Math.round(delta.x);
        let dy = Math.round(delta.y);
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        quad = d.quad.map((c) => ({ x: c.x + dx, y: c.y + dy })) as unknown as Quad;
        reference = { x: d.reference.x + dx, y: d.reference.y + dy };
        break;
      }
      case 'rotate': {
        let angle = Math.atan2(p.y - d.reference.y, p.x - d.reference.x);
        angle -= Math.atan2(d.start.y - d.reference.y, d.start.x - d.reference.x);
        if (e.shiftKey) {
          const before = affineParts(d.quad, s.bounds, s.skewV).angle;
          angle = (Math.round((before + angle * DEG) / 15) * 15 - before) / DEG;
        }
        quad = quadOf(multiply(about(d.reference, rotation(angle)), d.matrix), s.bounds);
        break;
      }
      case 'scale': {
        const handle = (d.hit as { handle: TransformHandle }).handle;
        const m = this.#scaled(d, handle, p, this.options.keepRatio !== e.shiftKey, e.altKey);
        quad = quadOf(m, s.bounds);
        reference = apply(m, apply(d.inverse, d.reference));
        break;
      }
      case 'distort': {
        const handle = (d.hit as { handle: TransformHandle }).handle;
        quad = d.quad.map((c, i) => (i === handle ? add(c, delta) : c)) as unknown as Quad;
        break;
      }
      case 'skew': {
        const [a, b] = SIDE_CORNERS[(d.hit as { handle: TransformHandle }).handle - 4]!;
        const [c, dd] = SIDE_CORNERS[((d.hit as { handle: TransformHandle }).handle - 4 + 2) % 4]!;
        const back = { x: -delta.x, y: -delta.y };
        quad = d.quad.map((corner, i) =>
          i === a || i === b ? add(corner, delta) : e.altKey && (i === c || i === dd) ? add(corner, back) : corner,
        ) as unknown as Quad;
        break;
      }
      case 'perspective': {
        const handle = (d.hit as { handle: TransformHandle }).handle as 0 | 1 | 2 | 3;
        // Along the box's top/bottom or left/right edge, whichever the pointer follows more.
        const local = sub(apply(d.inverse, p), apply(d.inverse, d.start));
        const horizontal = Math.abs(local.x) >= Math.abs(local.y);
        const partner = horizontal ? [1, 0, 3, 2][handle]! : [3, 2, 1, 0][handle]!;
        const edge = sub(d.quad[handle], d.quad[partner]!);
        const len2 = edge.x * edge.x + edge.y * edge.y || 1;
        const t = (delta.x * edge.x + delta.y * edge.y) / len2;
        const v = { x: edge.x * t, y: edge.y * t };
        quad = d.quad.map((c, i) => (i === handle ? add(c, v) : i === partner ? sub(c, v) : c)) as unknown as Quad;
        break;
      }
    }
    if (quad && !isValidQuad(quad)) return; // keep the last usable shape
    if (quad) {
      if (d.mode === 'distort' || d.mode === 'skew' || d.mode === 'perspective') {
        // The reference point keeps its place within the box.
        const m = rectToQuad(s.bounds, quad);
        if (m) reference = apply(m, apply(d.inverse, d.reference));
      }
      s.quad = quad;
    }
    s.reference = reference;
    this.#changed(ctx);
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!this.#drag) return;
    this.onPointerMove(e, ctx);
    this.#drag = null;
    this.#show(ctx);
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

  /** Abandons a drag in progress (the box returns to where it was). */
  cancel(ctx: ToolContext): void {
    const d = this.#drag;
    const s = this.#session;
    if (!d || !s) return;
    this.#drag = null;
    s.quad = d.quad;
    s.reference = d.reference;
    this.#changed(ctx);
  }

  /** Choosing another tool applies the transform, as the reference app's default answer does. */
  deactivate(ctx: ToolContext): void {
    if (this.#session) this.commit(ctx);
  }

  /** Applies the transform (nothing is recorded if the box did not change). */
  commit(ctx: ToolContext): void {
    const s = this.#session;
    if (!s) return;
    const m = this.matrix!;
    this.#end(ctx);
    const unchanged = m.every((v, i) => Math.abs(v - IDENTITY[i]!) < 1e-9);
    s.host.finish(unchanged ? null : this.#descriptor(m, this.options.interpolation));
  }

  /** Cancels the whole transform. */
  abandon(ctx: ToolContext): void {
    const s = this.#session;
    if (!s) return;
    this.#end(ctx);
    s.host.finish(null);
  }

  /** Typed numbers: position of the reference point, scale, angle, skews. */
  setNumbers(changes: Partial<AffineParts> & { x?: number; y?: number }, ctx: ToolContext): void {
    const s = this.#session;
    if (!s) return;
    const now = affineParts(s.quad, s.bounds, s.skewV);
    const next: AffineParts = { ...now, ...changes };
    if (this.options.keepRatio && changes.scaleX !== undefined && changes.scaleY === undefined && now.scaleX !== 0)
      next.scaleY = now.scaleY * (changes.scaleX / now.scaleX);
    if (this.options.keepRatio && changes.scaleY !== undefined && changes.scaleX === undefined && now.scaleY !== 0)
      next.scaleX = now.scaleX * (changes.scaleY / now.scaleY);
    // Change the affine part about the reference point; any distortion is kept.
    const before = affineFromParts(now, s.bounds, s.quad[0]);
    const after = affineFromParts(next, s.bounds, s.quad[0]);
    const invBefore = invert(before);
    if (!invBefore || !invert(after)) return;
    let delta = multiply(after, invBefore);
    const ref = s.reference;
    const moved = apply(delta, ref);
    delta = multiply(translation(ref.x - moved.x, ref.y - moved.y), delta);
    if (changes.x !== undefined || changes.y !== undefined)
      delta = multiply(translation((changes.x ?? ref.x) - ref.x, (changes.y ?? ref.y) - ref.y), delta);
    const quad = s.quad.map((c) => apply(delta, c)) as unknown as Quad;
    if (!isValidQuad(quad)) return;
    s.quad = quad;
    s.reference = apply(delta, ref);
    s.skewV = next.skewV;
    this.#changed(ctx);
  }

  /** Moves the reference point to a place on the box (fractions: 0 = left/top, 1 = right/bottom). */
  setReferenceAt(fx: number, fy: number, ctx: ToolContext): void {
    const s = this.#session;
    if (!s) return;
    s.reference = apply(this.matrix!, { x: s.bounds.x + s.bounds.w * fx, y: s.bounds.y + s.bounds.h * fy });
    this.#show(ctx);
  }

  setOptions(changes: Partial<TransformOptions>, ctx?: ToolContext): void {
    this.options = { ...this.options, ...changes };
    if (ctx) this.#show(ctx);
  }

  #descriptor(m: Mat3, interpolation: ResampleMethod): CommandDescriptor {
    return { name: 'freeTransform', params: { matrix: [...m], interpolation } };
  }

  /** What the live preview computes: the visible area, about one sample per screen pixel. */
  #draft(ctx: ToolContext): Rect & { step: number } {
    const v = ctx.viewport;
    const corners = [
      v.viewToDoc({ x: 0, y: 0 }),
      v.viewToDoc({ x: v.viewWidth, y: 0 }),
      v.viewToDoc({ x: 0, y: v.viewHeight }),
      v.viewToDoc({ x: v.viewWidth, y: v.viewHeight }),
    ];
    const x0 = Math.floor(Math.min(...corners.map((c) => c.x))) - 2;
    const y0 = Math.floor(Math.min(...corners.map((c) => c.y))) - 2;
    const x1 = Math.ceil(Math.max(...corners.map((c) => c.x))) + 2;
    const y1 = Math.ceil(Math.max(...corners.map((c) => c.y))) + 2;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, step: Math.min(8, Math.max(1, Math.floor(1 / v.zoom))) };
  }

  /** The new transform for a scale drag: in the box's own coordinates, about the anchor. */
  #scaled(d: Drag, handle: TransformHandle, p: Point, proportional: boolean, fromReference: boolean): Mat3 {
    const b = this.#session!.bounds;
    const local = (fx: number, fy: number): Point => ({ x: b.x + b.w * fx, y: b.y + b.h * fy });
    const [hx, hy] = HANDLE_AT[handle]!;
    const h = local(hx, hy);
    const anchor = fromReference ? apply(d.inverse, d.reference) : local(1 - hx, 1 - hy);
    const pl = apply(d.inverse, p);
    const safe = (f: number) => (Math.abs(f) < 1e-3 ? (f < 0 ? -1e-3 : 1e-3) : f);
    let fx = 1;
    let fy = 1;
    if (handle < 4) {
      fx = (pl.x - anchor.x) / (h.x - anchor.x || 1);
      fy = (pl.y - anchor.y) / (h.y - anchor.y || 1);
      // Proportional: the side the pointer pulls further decides, so the corner follows it.
      if (proportional) fx = fy = Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy;
    } else if (handle === 5 || handle === 7) {
      fx = (pl.x - anchor.x) / (h.x - anchor.x || 1);
      if (proportional) fy = fx;
    } else {
      fy = (pl.y - anchor.y) / (h.y - anchor.y || 1);
      if (proportional) fx = fy;
    }
    return multiply(d.matrix, about(anchor, scaling(safe(fx), safe(fy))));
  }

  #handlePoint(handle: TransformHandle): Point {
    const s = this.#session!;
    const [fx, fy] = HANDLE_AT[handle]!;
    return apply(this.matrix!, { x: s.bounds.x + s.bounds.w * fx, y: s.bounds.y + s.bounds.h * fy });
  }

  #hitTest(e: ToolPointerEvent, ctx: ToolContext): Hit {
    const s = this.#session;
    if (!s) return { kind: 'outside' };
    const v = ctx.viewport;
    const tol = GRAB * ctx.devicePixelRatio;
    const near = (p: Point) => {
      const q = v.docToView(p);
      return Math.hypot(q.x - e.x, q.y - e.y) <= tol;
    };
    if (this.options.showReference && near(s.reference)) return { kind: 'reference' };
    for (let h = 0; h < 8; h++)
      if (near(this.#handlePoint(h as TransformHandle))) return { kind: 'handle', handle: h as TransformHandle };
    // Inside the (convex) box, tested on screen.
    const q = s.quad.map((c) => v.docToView(c));
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i]!;
      const b = q[(i + 1) % 4]!;
      const cross = (b.x - a.x) * (e.y - a.y) - (b.y - a.y) * (e.x - a.x);
      const sg = Math.sign(cross);
      if (sg === 0) continue;
      if (sign !== 0 && sg !== sign) return { kind: 'outside' };
      sign = sg;
    }
    return { kind: 'inside' };
  }

  #changed(ctx: ToolContext): void {
    this.#show(ctx);
    this.#session?.host.preview(this.matrix!, this.#draft(ctx));
  }

  #show(ctx: ToolContext): void {
    for (const listener of this.#listeners) listener();
    const s = this.#session;
    ctx.setTransformBox(
      s
        ? {
            quad: s.quad,
            handles: HANDLE_AT.map((_, i) => this.#handlePoint(i as TransformHandle)),
            reference: this.options.showReference ? s.reference : null,
          }
        : null,
    );
  }

  #end(ctx: ToolContext): void {
    this.#session = null;
    this.#drag = null;
    this.#hover = null;
    this.#show(ctx);
  }
}
