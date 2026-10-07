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
import type { CropBoxOverlay, SelectionPreview, TransformBoxOverlay } from '../../tools/types';

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
  #brush: { x: number; y: number; size: number } | null = null;
  #crop: CropBoxOverlay | null = null;
  #transform: TransformBoxOverlay | null = null;
  #phase = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #still: boolean;

  constructor(canvas: HTMLCanvasElement, renderer: Renderer, trace: OutlineTracer) {
    this.#canvas = canvas;
    this.#renderer = renderer;
    this.#trace = trace;
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
        if (change.kind === 'selection' || change.kind === 'canvas') this.draw();
      }) ?? null;
    this.draw();
  }

  setPreview(preview: SelectionPreview | null): void {
    this.#preview = preview;
    this.draw();
  }

  /** The brush outline at a document point (diameter in document px), or none. */
  setBrushOutline(outline: { x: number; y: number; size: number } | null): void {
    this.#brush = outline;
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
    if (doc && this.#crop) this.#drawCrop(ctx, doc, this.#crop);
    if (doc && this.#transform) this.#drawTransform(ctx, this.#transform);
    if (doc && this.#brush) this.#drawBrush(ctx, this.#brush);
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

  #drawBrush(ctx: CanvasRenderingContext2D, brush: { x: number; y: number; size: number }): void {
    const v = this.#renderer.viewport;
    const c = v.docToView(brush);
    const r = (brush.size / 2) * v.zoom;
    if (r < 2) return; // tiny brushes: the crosshair cursor is enough
    const dpr = this.#renderer.devicePixelRatio;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, 2 * Math.PI);
    ctx.lineWidth = Math.max(1, Math.round(dpr)) * 2;
    ctx.strokeStyle = 'rgb(255 255 255 / 70%)';
    ctx.stroke();
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.strokeStyle = 'rgb(0 0 0 / 80%)';
    ctx.stroke();
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
