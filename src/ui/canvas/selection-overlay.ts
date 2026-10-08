/**
 * Marching ants: draws the document's selection outline — and the shape a
 * selection tool is drawing or the outline being moved — on a transparent 2D
 * canvas above the WebGL canvas. Outlines are traced in the pixel worker and
 * cached per selection (selections never change). The dashes march unless the
 * user prefers reduced motion.
 */
import type { OutlineTracer } from '../../app/services';
import type { ImageDocument } from '../../core/document/document';
import { shapePoints } from '../../core/selection/mask-ops';
import type { Selection } from '../../core/selection/selection';
import type { Renderer } from '../../engine/gl/renderer';
import { symmetryGuide, type Symmetry } from '../../core/paint/symmetry';
import type {
  BrushHud,
  BrushOutline,
  CropBoxOverlay,
  SelectionPreview,
  SymmetryEditOverlay,
  TransformBoxOverlay,
} from '../../tools/types';

type TipOutline = { loops: Float32Array[]; width: number; height: number };

/** Dash length, CSS pixels. */
const DASH = 4;
/** Time between march steps, ms. */
const MARCH_MS = 120;

export class SelectionOverlay {
  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: Renderer;
  readonly #trace: OutlineTracer;
  readonly #outlines = new WeakMap<Selection, Float32Array[] | 'pending'>();
  readonly #stopFrames: () => void;
  #doc: ImageDocument | null = null;
  #stopDoc: (() => void) | null = null;
  #preview: SelectionPreview | null = null;
  #brush: BrushOutline | null = null;
  #hud: BrushHud | null = null;
  /** The document's symmetry guide shows (a painting tool is active) unless hidden. */
  #symmetryShown = false;
  #symmetryHidden = false;
  #symmetryEdit: SymmetryEditOverlay | null = null;
  readonly #tipOutline: ((id: string, contour: 'normal' | 'full') => Promise<TipOutline | null>) | undefined;
  readonly #tipOutlines = new Map<string, TipOutline | 'pending' | null>();
  #crop: CropBoxOverlay | null = null;
  #transform: TransformBoxOverlay | null = null;
  #phase = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #still: boolean;

  constructor(
    canvas: HTMLCanvasElement,
    renderer: Renderer,
    trace: OutlineTracer,
    tipOutline?: (id: string, contour: 'normal' | 'full') => Promise<TipOutline | null>,
  ) {
    this.#canvas = canvas;
    this.#renderer = renderer;
    this.#trace = trace;
    this.#tipOutline = tipOutline;
    this.#still = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Redraw with every rendered frame, so the ants follow panning, zooming and rotation.
    this.#stopFrames = renderer.onFrame(() => this.draw());
  }

  setDocument(doc: ImageDocument | null): void {
    if (doc === this.#doc) return;
    this.#stopDoc?.();
    this.#doc = doc;
    this.#preview = null;
    this.#stopDoc =
      doc?.changes.on((change) => {
        if (change.kind === 'selection' || change.kind === 'canvas' || change.kind === 'symmetry') this.draw();
      }) ?? null;
    this.draw();
  }

  setPreview(preview: SelectionPreview | null): void {
    this.#preview = preview;
    this.draw();
  }

  /** The brush outline at a document point (diameter in document px, tip pose), or none. */
  setBrushOutline(outline: BrushOutline | null): void {
    this.#brush = outline;
    this.draw();
  }

  setSymmetryShown(shown: boolean): void {
    this.#symmetryShown = shown;
    this.draw();
  }

  setSymmetryHidden(hidden: boolean): void {
    this.#symmetryHidden = hidden;
    this.draw();
  }

  /** A symmetry guide being placed (drawn with its handles), or none. */
  setSymmetryEdit(edit: SymmetryEditOverlay | null): void {
    this.#symmetryEdit = edit;
    this.draw();
  }

  /** The brush HUD (a filled tip preview and readout), or none. */
  setBrushHud(hud: BrushHud | null): void {
    this.#hud = hud;
    this.draw();
  }

  /** The Crop tool's box (shaded outside, handles, thirds grid), or none. */
  setCropBox(box: CropBoxOverlay | null): void {
    this.#crop = box;
    this.draw();
  }

  /** Free Transform's box, or none. */
  setTransformBox(box: TransformBoxOverlay | null): void {
    this.#transform = box;
    this.draw();
  }

  /** The traced outline of the current selection, or null while it is being traced. */
  get outline(): Float32Array[] | null {
    const sel = this.#doc?.selection;
    const cached = sel ? this.#outlines.get(sel) : undefined;
    return Array.isArray(cached) ? cached : null;
  }

  dispose(): void {
    this.#stopFrames();
    this.#stopDoc?.();
    this.#animate(false);
  }

  draw(): void {
    const canvas = this.#canvas;
    const source = this.#renderer.canvas;
    if (canvas.width !== source.width || canvas.height !== source.height) {
      canvas.width = source.width;
      canvas.height = source.height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const doc = this.#doc;
    const loops = this.#loopsToDraw(doc);
    this.#animate(loops.length > 0);
    if (doc && this.#symmetryEdit) this.#drawSymmetry(ctx, doc, this.#symmetryEdit.symmetry, this.#symmetryEdit);
    else if (doc?.symmetry?.enabled && this.#symmetryShown && !this.#symmetryHidden)
      this.#drawSymmetry(ctx, doc, doc.symmetry, null);
    if (doc && this.#crop) this.#drawCrop(ctx, doc, this.#crop);
    if (doc && this.#transform) this.#drawTransform(ctx, this.#transform);
    if (doc && this.#hud) this.#drawHud(ctx, this.#hud);
    else if (doc && this.#brush) this.#drawBrush(ctx, this.#brush);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!doc || loops.length === 0) return;

    // Build the paths in document coordinates through the view transform…
    this.#docTransform(ctx);
    ctx.beginPath();
    for (const { points, closed } of loops) {
      ctx.moveTo(points[0]!, points[1]!);
      for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i]!, points[i + 1]!);
      if (closed) ctx.closePath();
    }
    // …then stroke in screen space, so dashes keep their size at any zoom.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = this.#renderer.devicePixelRatio;
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.setLineDash([]);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.setLineDash([DASH * dpr, DASH * dpr]);
    ctx.lineDashOffset = -this.#phase * dpr;
    ctx.strokeStyle = '#000';
    ctx.stroke();
  }

  /** Sets the 2D transform to draw in document coordinates. */
  #docTransform(ctx: CanvasRenderingContext2D): void {
    const v = this.#renderer.viewport;
    const r = (v.rotation * Math.PI) / 180;
    const c = Math.cos(r) * v.zoom;
    const s = Math.sin(r) * v.zoom;
    ctx.setTransform(
      c,
      s,
      -s,
      c,
      v.viewWidth / 2 - c * v.centerX + s * v.centerY,
      v.viewHeight / 2 - s * v.centerX - c * v.centerY,
    );
  }

  #drawCrop(ctx: CanvasRenderingContext2D, doc: ImageDocument, crop: CropBoxOverlay): void {
    const box = crop.rect ?? doc.canvasRect;
    const v = this.#renderer.viewport;
    const dpr = this.#renderer.devicePixelRatio;
    const line = Math.max(1, Math.round(dpr));
    // Shade everything outside the box.
    this.#docTransform(ctx);
    ctx.beginPath();
    const far = 1e7;
    ctx.rect(-far, -far, 2 * far, 2 * far);
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = 'rgb(0 0 0 / 55%)';
    ctx.fill('evenodd');
    // Border and thirds, stroked in screen space.
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    if (crop.thirds) {
      for (const f of [1 / 3, 2 / 3]) {
        ctx.moveTo(box.x + box.w * f, box.y);
        ctx.lineTo(box.x + box.w * f, box.y + box.h);
        ctx.moveTo(box.x, box.y + box.h * f);
        ctx.lineTo(box.x + box.w, box.y + box.h * f);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.setLineDash([]);
    ctx.lineWidth = line;
    ctx.strokeStyle = 'rgb(255 255 255 / 85%)';
    ctx.stroke();
    // Handles: corners and edge middles.
    const size = 8 * dpr;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgb(0 0 0 / 70%)';
    for (const [fx, fy] of [
      [0, 0],
      [0.5, 0],
      [1, 0],
      [1, 0.5],
      [1, 1],
      [0.5, 1],
      [0, 1],
      [0, 0.5],
    ] as const) {
      const p = v.docToView({ x: box.x + box.w * fx, y: box.y + box.h * fy });
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
      ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size);
    }
  }

  #drawTransform(ctx: CanvasRenderingContext2D, box: TransformBoxOverlay): void {
    const v = this.#renderer.viewport;
    const dpr = this.#renderer.devicePixelRatio;
    const line = Math.max(1, Math.round(dpr));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.setLineDash([]);
    ctx.beginPath();
    box.quad.forEach((c, i) => {
      const p = v.docToView(c);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.lineWidth = line * 3;
    ctx.strokeStyle = 'rgb(0 0 0 / 35%)';
    ctx.stroke();
    ctx.lineWidth = line;
    ctx.strokeStyle = '#3d8bf2';
    ctx.stroke();
    const size = 7 * dpr;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#3d8bf2';
    for (const h of box.handles) {
      const p = v.docToView(h);
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
      ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size);
    }
    if (box.reference) {
      // The reference point: a small target.
      const p = v.docToView(box.reference);
      const r = 5 * dpr;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
      ctx.moveTo(p.x - r * 1.6, p.y);
      ctx.lineTo(p.x + r * 1.6, p.y);
      ctx.moveTo(p.x, p.y - r * 1.6);
      ctx.lineTo(p.x, p.y + r * 1.6);
      ctx.lineWidth = line * 3;
      ctx.strokeStyle = 'rgb(255 255 255 / 80%)';
      ctx.stroke();
      ctx.lineWidth = line;
      ctx.strokeStyle = '#000';
      ctx.stroke();
    }
  }

  /** A sampled tip's outline at a contour (traced once, in the worker), or null while it is being traced. */
  #outlineOfTip(id: string, contour: 'normal' | 'full'): TipOutline | null {
    const key = `${contour}:${id}`;
    const cached = this.#tipOutlines.get(key);
    if (cached !== undefined) return cached === 'pending' ? null : cached;
    this.#tipOutlines.set(key, 'pending');
    void this.#tipOutline?.(id, contour).then(
      (outline) => {
        this.#tipOutlines.set(key, outline);
        this.draw();
      },
      () => this.#tipOutlines.set(key, null),
    );
    return null;
  }

  /**
   * Sets the 2D transform to a tip's own frame — units of document pixels, centred on the tip,
   * before its angle, flips and roundness — so paths and gradients drawn there land on the view.
   */
  #tipFrame(ctx: CanvasRenderingContext2D, tip: Omit<BrushOutline, 'size'>): void {
    const v = this.#renderer.viewport;
    const a = ((tip.angle ?? 0) * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const roundness = tip.roundness ?? 1;
    const at = (u: number, w: number) => {
      const fu = tip.flipX ? -u : u;
      const fv = (tip.flipY ? -w : w) * roundness;
      return v.docToView({ x: tip.x + c * fu + s * fv, y: tip.y - s * fu + c * fv });
    };
    const o = at(0, 0);
    const pu = at(1, 0);
    const pw = at(0, 1);
    ctx.setTransform(pu.x - o.x, pu.y - o.y, pw.x - o.x, pw.y - o.y, o.x, o.y);
  }

  /** The tip's outline as a path in its own frame (see #tipFrame): the traced sampled tip, or an ellipse. */
  #tipPath(ctx: CanvasRenderingContext2D, size: number, tipId: string | null | undefined, radius: number): void {
    ctx.beginPath();
    const tip = tipId ? this.#outlineOfTip(tipId, radius === size / 2 ? 'full' : 'normal') : null;
    if (tip && tip.loops.length > 0) {
      const scale = size / Math.max(tip.width, tip.height);
      for (const loop of tip.loops) {
        for (let i = 0; i < loop.length; i += 2) {
          const x = (loop[i]! - tip.width / 2) * scale;
          const y = (loop[i + 1]! - tip.height / 2) * scale;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
    } else {
      ctx.arc(0, 0, Math.max(0.01, radius), 0, 2 * Math.PI);
    }
  }

  /** A small crosshair at a view point. */
  #drawCrosshair(ctx: CanvasRenderingContext2D, p: { x: number; y: number }): void {
    const dpr = this.#renderer.devicePixelRatio;
    const arm = 6 * dpr;
    const gap = 2 * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      ctx.moveTo(p.x + dx * gap, p.y + dy * gap);
      ctx.lineTo(p.x + dx * arm, p.y + dy * arm);
    }
    ctx.lineWidth = Math.max(1, Math.round(dpr)) * 3;
    ctx.strokeStyle = 'rgb(255 255 255 / 80%)';
    ctx.stroke();
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.strokeStyle = '#000';
    ctx.stroke();
  }

  #drawBrush(ctx: CanvasRenderingContext2D, brush: BrushOutline): void {
    const v = this.#renderer.viewport;
    const dpr = this.#renderer.devicePixelRatio;
    const centre = v.docToView({ x: brush.x, y: brush.y });
    const tiny = (brush.size / 2) * v.zoom < 2;
    if (!brush.crosshairOnly && !tiny) {
      // Normal: where the round tip paints at least half — the middle of its soft rim (see dabCoverage).
      const r = brush.size / 2;
      const soft = Math.max(1, (1 - (brush.hardness ?? 1)) * r);
      const radius = brush.contour === 'full' ? r : Math.max(0.5, r - soft / 2);
      this.#tipFrame(ctx, brush);
      this.#tipPath(ctx, brush.size, brush.tip, radius);
      ctx.setTransform(1, 0, 0, 1, 0, 0); // stroke in screen pixels
      ctx.lineWidth = Math.max(1, Math.round(dpr)) * 2;
      ctx.strokeStyle = 'rgb(255 255 255 / 70%)';
      ctx.stroke();
      ctx.lineWidth = Math.max(1, Math.round(dpr));
      ctx.strokeStyle = 'rgb(0 0 0 / 80%)';
      ctx.stroke();
    }
    if (brush.crosshair || brush.crosshairOnly || tiny) this.#drawCrosshair(ctx, centre);
    if (brush.paintAt) this.#drawString(ctx, centre, brush.paintAt, brush.stringRadius);
  }

  /** A paint symmetry's guide (and, while it is placed, its centre, turn and size handles). */
  #drawSymmetry(
    ctx: CanvasRenderingContext2D,
    doc: ImageDocument,
    s: Symmetry,
    edit: SymmetryEditOverlay | null,
  ): void {
    const v = this.#renderer.viewport;
    const dpr = this.#renderer.devicePixelRatio;
    const line = Math.max(1, Math.round(dpr));
    const reach = Math.hypot(doc.width, doc.height) + Math.hypot(s.cx - doc.width / 2, s.cy - doc.height / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.setLineDash([]);
    ctx.beginPath();
    for (const { points, closed } of symmetryGuide(s, reach)) {
      for (let i = 0; i < points.length; i += 2) {
        const p = v.docToView({ x: points[i]!, y: points[i + 1]! });
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      if (closed) ctx.closePath();
    }
    ctx.lineWidth = line * 3;
    ctx.strokeStyle = 'rgb(0 0 0 / 30%)';
    ctx.stroke();
    ctx.lineWidth = line;
    ctx.strokeStyle = 'rgb(150 120 255 / 95%)';
    ctx.stroke();
    // The centre.
    const c = v.docToView({ x: s.cx, y: s.cy });
    ctx.beginPath();
    ctx.arc(c.x, c.y, 3 * dpr, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgb(150 120 255)';
    ctx.fill();
    if (!edit) return;
    const size = 8 * dpr;
    const r = v.docToView(edit.rotate);
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(r.x, r.y);
    ctx.lineWidth = line;
    ctx.strokeStyle = 'rgb(150 120 255 / 95%)';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgb(110 80 230)';
    ctx.beginPath();
    ctx.arc(r.x, r.y, size / 2 + 1, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    if (edit.scale) {
      const q = v.docToView(edit.scale);
      ctx.beginPath();
      ctx.moveTo(q.x, q.y - size * 0.7);
      ctx.lineTo(q.x + size * 0.7, q.y);
      ctx.lineTo(q.x, q.y + size * 0.7);
      ctx.lineTo(q.x - size * 0.7, q.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillRect(c.x - size / 2, c.y - size / 2, size, size);
    ctx.strokeRect(c.x - size / 2, c.y - size / 2, size, size);
  }

  /** Smoothing's string: from the pointer to where the paint is (and its reach in Pulled String Mode). */
  #drawString(
    ctx: CanvasRenderingContext2D,
    pointer: { x: number; y: number },
    paintAt: { x: number; y: number },
    radius: number | undefined,
  ): void {
    const v = this.#renderer.viewport;
    const dpr = this.#renderer.devicePixelRatio;
    const p = v.docToView(paintAt);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.moveTo(pointer.x, pointer.y);
    ctx.lineTo(p.x, p.y);
    if (radius !== undefined && radius > 0) {
      ctx.moveTo(p.x + radius * v.zoom, p.y);
      ctx.arc(p.x, p.y, radius * v.zoom, 0, 2 * Math.PI);
    }
    ctx.lineWidth = Math.max(1, Math.round(dpr)) * 3;
    ctx.strokeStyle = 'rgb(0 0 0 / 35%)';
    ctx.stroke();
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.strokeStyle = 'rgb(176 132 255 / 95%)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5 * dpr, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgb(176 132 255)';
    ctx.fill();
  }

  /** The brush HUD: the tip filled in the preview colour (soft where the tip is soft) and a readout. */
  #drawHud(ctx: CanvasRenderingContext2D, hud: BrushHud): void {
    const v = this.#renderer.viewport;
    const dpr = this.#renderer.devicePixelRatio;
    const r = hud.size / 2;
    const { r: cr, g: cg, b: cb } = hud.color;
    const rgb = `${Math.round(cr * 255)} ${Math.round(cg * 255)} ${Math.round(cb * 255)}`;
    this.#tipFrame(ctx, hud);
    if (hud.tip) {
      this.#tipPath(ctx, hud.size, hud.tip, r - 1);
      ctx.fillStyle = `rgb(${rgb} / 50%)`;
      ctx.fill();
    } else {
      const soft = Math.max(1, (1 - hud.hardness) * r);
      const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      gradient.addColorStop(0, `rgb(${rgb} / 50%)`);
      gradient.addColorStop(Math.max(0, (r - soft) / r), `rgb(${rgb} / 50%)`);
      gradient.addColorStop(1, `rgb(${rgb} / 0%)`);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, 2 * Math.PI);
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    // The readout, to the right of the preview.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const centre = v.docToView({ x: hud.x, y: hud.y });
    const font = 12 * dpr;
    ctx.font = `${font}px system-ui, sans-serif`;
    const pad = 6 * dpr;
    const lineHeight = font * 1.35;
    const width = Math.max(...hud.lines.map((l) => ctx.measureText(l).width)) + pad * 2;
    const height = hud.lines.length * lineHeight + pad * 2 - (lineHeight - font);
    // Right of the preview, or left of it where the canvas ends; never past the top or bottom.
    const gap = r * v.zoom + 12 * dpr;
    const right = centre.x + gap;
    const x = right + width <= this.#canvas.width ? right : Math.max(0, centre.x - gap - width);
    const y = Math.min(Math.max(0, centre.y - height / 2), Math.max(0, this.#canvas.height - height));
    ctx.fillStyle = 'rgb(30 30 30 / 88%)';
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = '#eee';
    ctx.textBaseline = 'top';
    hud.lines.forEach((line, i) => ctx.fillText(line, x + pad, y + pad + i * lineHeight));
  }

  #loopsToDraw(doc: ImageDocument | null): { points: ArrayLike<number>; closed: boolean }[] {
    if (!doc) return [];
    const loops: { points: ArrayLike<number>; closed: boolean }[] = [];
    const preview = this.#preview;
    const sel = doc.selection;
    // A new selection being drawn hides the current one; adding/subtracting keeps it visible.
    if (sel && !(preview?.kind === 'shape' && preview.hideCurrent)) {
      const outline = this.#outlineOf(doc, sel);
      const dx = preview?.kind === 'move' ? preview.dx : 0;
      const dy = preview?.kind === 'move' ? preview.dy : 0;
      for (const loop of outline) {
        if (dx === 0 && dy === 0) loops.push({ points: loop, closed: true });
        else loops.push({ points: loop.map((p, i) => p + (i % 2 === 0 ? dx : dy)), closed: true });
      }
    }
    if (preview && preview.kind !== 'move') {
      const points = shapePoints(preview.shape);
      if (points.length >= 4) loops.push({ points, closed: preview.closed });
    }
    return loops;
  }

  #outlineOf(doc: ImageDocument, sel: Selection): Float32Array[] {
    const cached = this.#outlines.get(sel);
    if (Array.isArray(cached)) return cached;
    if (cached !== 'pending') {
      this.#outlines.set(sel, 'pending');
      this.#trace(sel.data, doc.canvasRect).then(
        (loops) => {
          this.#outlines.set(sel, loops);
          if (this.#doc?.selection === sel) this.draw();
        },
        () => this.#outlines.set(sel, []),
      );
    }
    return [];
  }

  #animate(on: boolean): void {
    if (on && !this.#timer && !this.#still) {
      this.#timer = setInterval(() => {
        this.#phase = (this.#phase + 1) % (DASH * 2);
        this.draw();
      }, MARCH_MS);
    } else if (!on && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
