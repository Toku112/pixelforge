/**
 * Turns DOM pointer, wheel and keyboard events on the canvas into tool actions.
 *
 * - Left-drag uses the active tool. Holding Space switches temporarily to the Hand
 *   tool; Ctrl/Cmd+Space to the Zoom tool (add Alt/Option to zoom out).
 * - Wheel / two-finger scroll pans (Shift: horizontal). Alt/Option+wheel and
 *   pinch (wheel events with Ctrl) zoom around the pointer.
 * - Escape abandons the current drag. Enter, Escape and Backspace/Delete go to the
 *   active tool first when it is in the middle of something (polygonal lasso).
 * - Pressing or releasing Shift, Alt/Option or Space during a drag updates the
 *   tool at once (e.g. a marquee becomes a square), without moving the pointer.
 */
import type { Tool, ToolContext, ToolPointerEvent } from '../../tools/types';
import type { ToolSet } from '../../tools/registry';

export interface CanvasInputOptions {
  element: HTMLElement;
  tools: ToolSet;
  context: ToolContext;
  getActiveToolId(): string;
  devicePixelRatio(): number;
  /** Called when a drag starts on the canvas (ends spring-loaded tool switches on key release). */
  onGestureStart?(): void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** Zoom factor per CSS pixel of wheel delta (a mouse-wheel notch of 100 px ≈ ×0.82). */
const WHEEL_ZOOM_RATE = 0.002;
/** Keys offered to the active tool before anything else handles them. */
const TOOL_KEYS = new Set(['Enter', 'Escape', 'Backspace', 'Delete']);

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export class CanvasInput {
  readonly #o: CanvasInputOptions;
  #dragTool: Tool | null = null;
  #pointerId: number | null = null;
  #space = false;
  #alt = false;
  #primary = false;
  /** Last pointer position during a drag (re-sent when modifier keys change). */
  #lastMove: ToolPointerEvent | null = null;
  #activeTool: Tool | null = null;
  readonly #cleanup: (() => void)[] = [];

  constructor(options: CanvasInputOptions) {
    this.#o = options;
    const el = options.element;
    this.#listen(el, 'pointerdown', this.#onPointerDown);
    this.#listen(el, 'pointermove', this.#onPointerMove);
    this.#listen(el, 'pointerup', this.#onPointerUp);
    this.#listen(el, 'pointercancel', this.#onPointerCancel);
    this.#listen(el, 'pointerleave', this.#onPointerLeave);
    this.#listen(el, 'wheel', this.#onWheel, { passive: false });
    this.#listen(window, 'keydown', this.#onKeyDown);
    this.#listen(window, 'keyup', this.#onKeyUp);
    this.#listen(window, 'blur', this.#onBlur);
    this.#updateCursor();
  }

  /** The tool a press would use now (temporary tools win over the active one). */
  get currentTool(): Tool {
    const { tools } = this.#o;
    if (this.#space) return this.#primary ? tools.zoom : tools.hand;
    return tools.byId.get(this.#o.getActiveToolId()) ?? tools.hand;
  }

  /** Call when the active tool or the document changes (abandons a tool's unfinished work). */
  refresh(): void {
    const active = this.#o.tools.byId.get(this.#o.getActiveToolId()) ?? null;
    if (this.#activeTool && this.#activeTool !== active) this.#activeTool.cancel?.(this.#o.context);
    this.#activeTool = active;
    this.#updateCursor();
  }

  /** Abandons whatever the active tool is in the middle of (e.g. the document changed). */
  cancelTool(): void {
    this.#cancelDrag();
    this.#activeTool?.cancel?.(this.#o.context);
  }

  dispose(): void {
    this.#cancelDrag();
    for (const off of this.#cleanup.splice(0)) off();
  }

  #listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    const fn = handler as EventListener;
    target.addEventListener(type, fn, options);
    this.#cleanup.push(() => target.removeEventListener(type, fn, options));
  }

  #toolEvent(e: MouseEvent): ToolPointerEvent {
    const rect = this.#o.element.getBoundingClientRect();
    const dpr = this.#o.devicePixelRatio();
    return {
      x: (e.clientX - rect.left) * dpr,
      y: (e.clientY - rect.top) * dpr,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      primaryKey: isMac ? e.metaKey : e.ctrlKey,
      spaceKey: this.#space,
      pressure: 'pointerType' in e && (e as PointerEvent).pointerType === 'pen' ? (e as PointerEvent).pressure : 1,
    };
  }

  readonly #onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.#dragTool) return;
    e.preventDefault();
    this.#o.element.focus({ preventScroll: true });
    this.#o.element.setPointerCapture(e.pointerId);
    this.#pointerId = e.pointerId;
    this.#dragTool = this.currentTool;
    this.#o.onGestureStart?.();
    this.#dragTool.onPointerDown?.(this.#toolEvent(e), this.#o.context);
    this.#updateCursor();
  };

  readonly #onPointerMove = (e: PointerEvent) => {
    if (this.#dragTool && e.pointerId === this.#pointerId) {
      // Coalesced events give every intermediate position for smooth drags.
      for (const ev of e.getCoalescedEvents?.() ?? [e]) {
        this.#lastMove = this.#toolEvent(ev);
        this.#dragTool.onPointerMove?.(this.#lastMove, this.#o.context);
      }
    } else if (!this.#dragTool && this.#o.context.document) {
      this.currentTool.onPointerHover?.(this.#toolEvent(e), this.#o.context);
    }
    this.#syncModifiers(e);
  };

  readonly #onPointerUp = (e: PointerEvent) => {
    if (!this.#dragTool || e.pointerId !== this.#pointerId) return;
    const tool = this.#dragTool;
    this.#dragTool = null;
    this.#pointerId = null;
    this.#lastMove = null;
    tool.onPointerUp?.(this.#toolEvent(e), this.#o.context);
    this.#updateCursor();
  };

  readonly #onPointerCancel = () => this.#cancelDrag();

  readonly #onPointerLeave = () => {
    if (!this.#dragTool) this.currentTool.onPointerLeave?.(this.#o.context);
  };

  readonly #onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const ctx = this.#o.context;
    if (!ctx.document) return;
    const dpr = this.#o.devicePixelRatio();
    const unit =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? window.innerHeight
          : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.ctrlKey || e.altKey) {
      ctx.viewport.zoomBy(Math.exp(-dy * WHEEL_ZOOM_RATE), this.#toolEvent(e));
    } else if (e.shiftKey && dx === 0) {
      ctx.viewport.panBy(-dy * dpr, 0);
    } else {
      ctx.viewport.panBy(-dx * dpr, -dy * dpr);
    }
    ctx.viewChanged();
  };

  readonly #onKeyDown = (e: KeyboardEvent) => {
    this.#syncModifiers(e);
    if (isEditable(e.target)) return;
    // Keys a tool may use mid-task (e.g. the polygonal lasso: Enter closes, Backspace removes a corner).
    if (TOOL_KEYS.has(e.key) && (this.#dragTool ?? this.currentTool).onKeyDown?.(e.key, this.#o.context)) {
      e.preventDefault();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault(); // no page scrolling
      if (!this.#space) {
        this.#space = true;
        this.#updateCursor();
      }
    } else if (e.key === 'Escape') {
      this.#cancelDrag();
    }
    this.#resendModifiers(e);
  };

  readonly #onKeyUp = (e: KeyboardEvent) => {
    this.#syncModifiers(e);
    if (e.code === 'Space' && this.#space) {
      this.#space = false;
      this.#updateCursor();
    }
    this.#resendModifiers(e);
  };

  /** During a drag, pressing or releasing Shift, Alt/Option or Space takes effect at once. */
  #resendModifiers(e: KeyboardEvent): void {
    const last = this.#lastMove;
    if (!this.#dragTool || !last || !['Shift', 'Alt', 'Meta', 'Control', ' '].includes(e.key)) return;
    this.#lastMove = {
      ...last,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      primaryKey: isMac ? e.metaKey : e.ctrlKey,
      spaceKey: this.#space,
    };
    this.#dragTool.onPointerMove?.(this.#lastMove, this.#o.context);
  }

  readonly #onBlur = () => {
    this.#space = this.#alt = this.#primary = false;
    this.#cancelDrag();
  };

  #syncModifiers(e: KeyboardEvent | MouseEvent): void {
    const primary = isMac ? e.metaKey : e.ctrlKey;
    if (e.altKey !== this.#alt || primary !== this.#primary) {
      this.#alt = e.altKey;
      this.#primary = primary;
      this.#updateCursor();
    }
  }

  #cancelDrag(): void {
    if (!this.#dragTool) return;
    this.#dragTool.cancel?.(this.#o.context);
    if (this.#pointerId !== null && this.#o.element.hasPointerCapture(this.#pointerId)) {
      this.#o.element.releasePointerCapture(this.#pointerId);
    }
    this.#dragTool = null;
    this.#pointerId = null;
    this.#updateCursor();
  }

  #updateCursor(): void {
    const tool = this.#dragTool ?? this.currentTool;
    this.#o.element.style.cursor = this.#o.context.document
      ? tool.cursor({ altKey: this.#alt, dragging: !!this.#dragTool })
      : 'default';
  }
}
