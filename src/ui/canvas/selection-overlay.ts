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
import type { SelectionPreview } from '../../tools/types';

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
    if (!doc || loops.length === 0) return;

    // Build the paths in document coordinates through the view transform…
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
