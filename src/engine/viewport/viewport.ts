/**
 * The view transform between document pixels and the canvas.
 *
 * Coordinates: document pixels (x right, y down) and view pixels — *device* pixels
 * of the canvas, origin top-left. Zoom is device pixels per document pixel, so 100 %
 * shows one image pixel per screen pixel even on high-density displays, as pro
 * image editors do ("Actual Pixels").
 *
 *   view = R(rotation) · zoom · (doc − center) + viewCenter
 *
 * Rotation is in degrees, positive = clockwise on screen.
 */

export const MIN_ZOOM = 0.001; // 0.1 %
export const MAX_ZOOM = 128; // 12 800 %

/** Preset zoom levels used by Zoom In / Zoom Out (fractions; 1 = 100 %). */
export const ZOOM_STEPS: readonly number[] = [
  0.001, 0.0015, 0.002, 0.0025, 0.0033, 0.005, 0.0067, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.0625, 0.0833, 0.125,
  0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32, 48, 64, 96, 128,
];

/** Above this zoom the pixel grid is shown (when enabled). */
export const PIXEL_GRID_MIN_ZOOM = 5;

export interface Point {
  x: number;
  y: number;
}

export interface ViewportState {
  /** Device pixels per document pixel. */
  zoom: number;
  /** Degrees, clockwise. */
  rotation: number;
  /** Document point shown at the centre of the view. */
  centerX: number;
  centerY: number;
  /** View size in device pixels. */
  viewWidth: number;
  viewHeight: number;
}

const EPSILON = 1e-9;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Normalises an angle to (−180, 180]. */
export function normalizeAngle(degrees: number): number {
  let a = degrees % 360;
  if (a <= -180) a += 360;
  if (a > 180) a -= 360;
  return a === 0 ? 0 : a; // avoid -0
}

export class Viewport {
  zoom = 1;
  rotation = 0;
  centerX = 0;
  centerY = 0;
  viewWidth = 1;
  viewHeight = 1;

  constructor(state: Partial<ViewportState> = {}) {
    Object.assign(this, state);
    this.zoom = clampZoom(this.zoom);
  }

  get state(): ViewportState {
    const { zoom, rotation, centerX, centerY, viewWidth, viewHeight } = this;
    return { zoom, rotation, centerX, centerY, viewWidth, viewHeight };
  }

  #cosSin(): [number, number] {
    const r = (this.rotation * Math.PI) / 180;
    return [Math.cos(r), Math.sin(r)];
  }

  docToView(p: Point): Point {
    const [c, s] = this.#cosSin();
    const dx = (p.x - this.centerX) * this.zoom;
    const dy = (p.y - this.centerY) * this.zoom;
    return { x: c * dx - s * dy + this.viewWidth / 2, y: s * dx + c * dy + this.viewHeight / 2 };
  }

  viewToDoc(p: Point): Point {
    const [c, s] = this.#cosSin();
    const dx = p.x - this.viewWidth / 2;
    const dy = p.y - this.viewHeight / 2;
    return { x: (c * dx + s * dy) / this.zoom + this.centerX, y: (-s * dx + c * dy) / this.zoom + this.centerY };
  }

  /** Re-centres so that document point `doc` appears at view point `view`. */
  #pin(doc: Point, view: Point): void {
    const [c, s] = this.#cosSin();
    const dx = view.x - this.viewWidth / 2;
    const dy = view.y - this.viewHeight / 2;
    this.centerX = doc.x - (c * dx + s * dy) / this.zoom;
    this.centerY = doc.y - (-s * dx + c * dy) / this.zoom;
  }

  #viewCenter(): Point {
    return { x: this.viewWidth / 2, y: this.viewHeight / 2 };
  }

  /** Sets the zoom, keeping the document point under `anchor` (default: view centre) in place. */
  zoomTo(zoom: number, anchor: Point = this.#viewCenter()): void {
    const doc = this.viewToDoc(anchor);
    this.zoom = clampZoom(zoom);
    this.#pin(doc, anchor);
  }

  /** Continuous zoom by a factor (wheel, pinch, scrubby zoom). */
  zoomBy(factor: number, anchor?: Point): void {
    this.zoomTo(this.zoom * factor, anchor);
  }

  /** Next larger preset zoom level. */
  zoomIn(anchor?: Point): void {
    const next = ZOOM_STEPS.find((z) => z > this.zoom * (1 + 1e-6)) ?? MAX_ZOOM;
    this.zoomTo(next, anchor);
  }

  /** Next smaller preset zoom level. */
  zoomOut(anchor?: Point): void {
    const next = [...ZOOM_STEPS].reverse().find((z) => z < this.zoom * (1 - 1e-6)) ?? MIN_ZOOM;
    this.zoomTo(next, anchor);
  }

  /** Moves the view by a distance in view pixels (content follows the pointer). */
  panBy(dx: number, dy: number): void {
    const [c, s] = this.#cosSin();
    this.centerX -= (c * dx + s * dy) / this.zoom;
    this.centerY -= (-s * dx + c * dy) / this.zoom;
  }

  /** Sets the view rotation, keeping the document point under `anchor` (default: centre) in place. */
  rotateTo(degrees: number, anchor: Point = this.#viewCenter()): void {
    const doc = this.viewToDoc(anchor);
    this.rotation = normalizeAngle(degrees);
    this.#pin(doc, anchor);
  }

  /** Keeps the view centre fixed in the document while the canvas is resized. */
  setViewSize(width: number, height: number): void {
    this.viewWidth = Math.max(1, width);
    this.viewHeight = Math.max(1, height);
  }

  /** Zooms and centres so the whole (rotated) document fits, leaving `margin` view pixels around it. */
  fit(docWidth: number, docHeight: number, margin = 0): void {
    const [c, s] = this.#cosSin();
    const bw = Math.abs(docWidth * c) + Math.abs(docHeight * s);
    const bh = Math.abs(docWidth * s) + Math.abs(docHeight * c);
    const availW = Math.max(1, this.viewWidth - 2 * margin);
    const availH = Math.max(1, this.viewHeight - 2 * margin);
    this.zoom = clampZoom(Math.min(availW / bw, availH / bh));
    this.centerX = docWidth / 2;
    this.centerY = docHeight / 2;
  }

  /** Shows the document at `zoom`, centred. */
  centerDocument(docWidth: number, docHeight: number, zoom = this.zoom): void {
    this.zoom = clampZoom(zoom);
    this.centerX = docWidth / 2;
    this.centerY = docHeight / 2;
  }

  /**
   * Keeps the document in view, like the reference app with "Overscroll" off:
   * unrotated, a document smaller than the view (on an axis) stays centred, and a
   * larger one can be panned until its edge meets the view edge. When rotated (or
   * with `overscroll`), panning is free as long as the view centre stays on the document.
   */
  clampToDocument(docWidth: number, docHeight: number, overscroll = false): void {
    const clampAxis = (center: number, doc: number, view: number) => {
      const half = view / 2 / this.zoom;
      if (doc <= 2 * half) return doc / 2;
      return Math.min(doc - half, Math.max(half, center));
    };
    if (this.rotation === 0 && !overscroll) {
      this.centerX = clampAxis(this.centerX, docWidth, this.viewWidth);
      this.centerY = clampAxis(this.centerY, docHeight, this.viewHeight);
    } else {
      this.centerX = Math.min(docWidth, Math.max(0, this.centerX));
      this.centerY = Math.min(docHeight, Math.max(0, this.centerY));
    }
  }

  /** Zooms so the document fills the view (no empty borders), centred. */
  fill(docWidth: number, docHeight: number): void {
    const [c, s] = this.#cosSin();
    const bw = Math.abs(docWidth * c) + Math.abs(docHeight * s);
    const bh = Math.abs(docWidth * s) + Math.abs(docHeight * c);
    this.zoom = clampZoom(Math.max(this.viewWidth / bw, this.viewHeight / bh));
    this.centerX = docWidth / 2;
    this.centerY = docHeight / 2;
  }

  /** Axis-aligned document-space bounds of what the view shows. */
  visibleDocRect(): { x: number; y: number; w: number; h: number } {
    const corners = [
      this.viewToDoc({ x: 0, y: 0 }),
      this.viewToDoc({ x: this.viewWidth, y: 0 }),
      this.viewToDoc({ x: 0, y: this.viewHeight }),
      this.viewToDoc({ x: this.viewWidth, y: this.viewHeight }),
    ];
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  /** Column-major 3×3 matrix mapping document pixels to WebGL clip space. */
  docToClipMatrix(): Float32Array {
    const [c, s] = this.#cosSin();
    const z = this.zoom;
    const sx = 2 / this.viewWidth;
    const sy = -2 / this.viewHeight;
    // view = A·doc + t, with A = z·R and t = viewCenter − A·center.
    const a = c * z;
    const b = -s * z;
    const d = s * z;
    const e = c * z;
    const tx = this.viewWidth / 2 - (a * this.centerX + b * this.centerY);
    const ty = this.viewHeight / 2 - (d * this.centerX + e * this.centerY);
    // clip = S·view + (−1, 1)
    return new Float32Array([a * sx, d * sy, 0, b * sx, e * sy, 0, tx * sx - 1, ty * sy + 1, 1]);
  }

  /** Whether the pixel grid should be visible at the current zoom. */
  get showsPixelGrid(): boolean {
    return this.zoom > PIXEL_GRID_MIN_ZOOM + EPSILON;
  }
}
