/**
 * The document canvas: owns the WebGL renderer, sizes its drawing buffer to the
 * element in device pixels (also when the window moves to a display with another
 * pixel density), and connects pointer input to the tools. React mounts it but
 * never renders the canvas itself (CLAUDE.md §2).
 */
import type { OutlineTracer } from '../../app/services';
import type { CommandDescriptor } from '../../core/commands/command';
import type { ImageDocument } from '../../core/document/document';
import { Renderer, type RendererOptions } from '../../engine/gl/renderer';
import type { ViewportState } from '../../engine/viewport/viewport';
import type { ToolSet } from '../../tools/registry';
import type { PaintHost, ToolContext, ViewRect } from '../../tools/types';
import { CanvasInput } from './canvas-input';
import { SelectionOverlay } from './selection-overlay';

export interface CanvasViewOptions {
  tools: ToolSet;
  getActiveToolId(): string;
  /** Preferences > Tools > Overscroll (default off). */
  overscroll?(): boolean;
  /** Called after the view (zoom, position, rotation) changes. */
  onViewChange?(state: ViewportState): void;
  /** Called when a drag starts on the canvas. */
  onGestureStart?(): void;
  /** Runs a document command for a tool (e.g. a selection tool's result). */
  execute?(descriptor: CommandDescriptor): void;
  /** Starts brush/eraser strokes. */
  paint?: PaintHost;
  /** Live preview of a tool's command (null cancels it). */
  preview?(descriptor: CommandDescriptor | null): void;
  selectLayers?(ids: string[]): void;
  report?(title: string, message: string): void;
  /** Marching ants: a 2D canvas stacked above the document canvas, and the outline tracer. */
  ants?: { canvas: HTMLCanvasElement; trace: OutlineTracer };
  renderer?: RendererOptions;
}

/** Margin around the document when fitting it on screen, CSS pixels. */
export const FIT_MARGIN = 16;

export class CanvasView {
  readonly renderer: Renderer;
  readonly context: ToolContext;
  readonly #host: HTMLElement;
  readonly #overlay: HTMLElement;
  readonly #options: CanvasViewOptions;
  readonly #input: CanvasInput;
  readonly #ants: SelectionOverlay | null;
  readonly #resizeObserver: ResizeObserver;
  #dprQuery: MediaQueryList | null = null;
  #cssSize = { w: 1, h: 1 };
  #pendingFit: 'open' | 'fit' | null = null;

  constructor(host: HTMLElement, canvas: HTMLCanvasElement, overlay: HTMLElement, options: CanvasViewOptions) {
    this.#host = host;
    this.#overlay = overlay;
    this.#options = options;
    this.renderer = new Renderer(canvas, options.renderer);
    const renderer = this.renderer;
    this.#ants = options.ants ? new SelectionOverlay(options.ants.canvas, renderer, options.ants.trace) : null;
    this.context = {
      get viewport() {
        return renderer.viewport;
      },
      get document() {
        return renderer.document;
      },
      get devicePixelRatio() {
        return renderer.devicePixelRatio;
      },
      viewChanged: () => this.#viewChanged(),
      setOverlayRect: (rect) => this.#showOverlay(rect),
      setSelectionPreview: (preview) => this.#ants?.setPreview(preview),
      execute: (descriptor) => options.execute?.(descriptor),
      paint: options.paint ?? null,
      setBrushOutline: (outline) => this.#ants?.setBrushOutline(outline),
      preview: (descriptor) => options.preview?.(descriptor),
      selectLayers: (ids) => options.selectLayers?.(ids),
      report: (title, message) => options.report?.(title, message),
    };
    canvas.tabIndex = 0; // focusable, so keyboard tools work after clicking the canvas
    this.#input = new CanvasInput({
      element: canvas,
      tools: options.tools,
      context: this.context,
      getActiveToolId: () => options.getActiveToolId(),
      devicePixelRatio: () => this.renderer.devicePixelRatio,
      onGestureStart: () => options.onGestureStart?.(),
    });
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(host);
    this.#watchPixelRatio();
    this.#resize();
  }

  get viewState(): ViewportState {
    return this.renderer.viewport.state;
  }

  /** Shows a document, restoring a saved view or fitting it on screen. */
  setDocument(doc: ImageDocument | null, view?: ViewportState): void {
    if (doc !== this.renderer.document) this.#input.cancelTool(); // e.g. a half-drawn polygon
    this.renderer.setDocument(doc);
    this.#ants?.setDocument(doc);
    if (doc && view) {
      Object.assign(this.renderer.viewport, {
        zoom: view.zoom,
        rotation: view.rotation,
        centerX: view.centerX,
        centerY: view.centerY,
      });
      this.#viewChanged();
    } else if (doc) {
      this.#fit(true);
    }
    this.#input.refresh();
  }

  /** View > Fit on Screen: the whole image, as large as the window allows (may exceed 100 %). */
  fitOnScreen(): void {
    this.#fit(false);
  }

  /**
   * Fits the document; when `atMost100` (a newly opened document, as in the reference
   * app) small images are shown at 100 % rather than enlarged.
   */
  #fit(atMost100: boolean): void {
    const doc = this.renderer.document;
    if (!doc) return;
    if (this.#cssSize.w <= 1 || this.#cssSize.h <= 1) {
      this.#pendingFit = atMost100 ? 'open' : 'fit'; // not laid out yet: fit after the first resize
      return;
    }
    const viewport = this.renderer.viewport;
    viewport.fit(doc.width, doc.height, FIT_MARGIN * this.renderer.devicePixelRatio);
    if (atMost100 && viewport.zoom > 1) viewport.centerDocument(doc.width, doc.height, 1);
    this.#viewChanged();
  }

  /** Call when the active tool changes (updates the cursor). */
  toolChanged(): void {
    this.#input.refresh();
  }

  /** The marching-ants overlay (for diagnostics and tests). */
  get selectionOverlay(): SelectionOverlay | null {
    return this.#ants;
  }

  dispose(): void {
    this.#input.dispose();
    this.#ants?.dispose();
    this.#resizeObserver.disconnect();
    this.#dprQuery?.removeEventListener('change', this.#onPixelRatioChange);
    this.renderer.dispose();
  }

  #viewChanged(): void {
    const doc = this.renderer.document;
    if (doc) this.renderer.viewport.clampToDocument(doc.width, doc.height, this.#options.overscroll?.() ?? false);
    this.renderer.requestRender();
    this.#options.onViewChange?.(this.renderer.viewport.state);
  }

  #resize(): void {
    const rect = this.#host.getBoundingClientRect();
    this.#cssSize = { w: rect.width, h: rect.height };
    // Zoom is in device pixels, so 100 % stays one image pixel per screen pixel on any display.
    this.renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1);
    if (this.#pendingFit && rect.width > 1 && rect.height > 1) {
      const kind = this.#pendingFit;
      this.#pendingFit = null;
      this.#fit(kind === 'open');
      return;
    }
    this.#viewChanged();
  }

  #watchPixelRatio(): void {
    this.#dprQuery?.removeEventListener('change', this.#onPixelRatioChange);
    this.#dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.#dprQuery.addEventListener('change', this.#onPixelRatioChange);
  }

  readonly #onPixelRatioChange = () => {
    this.#watchPixelRatio();
    this.#resize();
  };

  #showOverlay(rect: ViewRect | null): void {
    const style = this.#overlay.style;
    if (!rect) {
      style.display = 'none';
      return;
    }
    const dpr = this.renderer.devicePixelRatio;
    style.display = 'block';
    style.left = `${rect.x / dpr}px`;
    style.top = `${rect.y / dpr}px`;
    style.width = `${rect.w / dpr}px`;
    style.height = `${rect.h / dpr}px`;
  }
}
