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
 * - Alt+right-drag (Ctrl+Option-drag on macOS) sizes the brush of tools that have
 *   one (the brush HUD). The canvas has no browser context menu.
 * - Caps Lock switches painting cursors to the precise crosshair.
 */
import { effectivePaintCursor, type Tool, type ToolContext, type ToolPointerEvent } from '../../tools/types';
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

/**
 * Pen tilt in degrees along x and y. Browsers that describe the pen by altitude and
 * azimuth (Safari) leave tiltX/Y at 0; then they are derived (Pointer Events 3).
 */
function penTilt(e: PointerEvent): [number, number] {
  const ext = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
  if (e.tiltX !== 0 || e.tiltY !== 0 || ext.altitudeAngle === undefined || ext.azimuthAngle === undefined)
    return [e.tiltX, e.tiltY];
  const alt = ext.altitudeAngle;
  if (alt >= Math.PI / 2 - 1e-6) return [0, 0]; // upright
  const deg = 180 / Math.PI;
  const t = Math.tan(alt);
  return [Math.atan(Math.cos(ext.azimuthAngle) / t) * deg, Math.atan(Math.sin(ext.azimuthAngle) / t) * deg];
}

export class CanvasInput {
  readonly #o: CanvasInputOptions;
  #dragTool: Tool | null = null;
  #pointerId: number | null = null;
  #space = false;
  #alt = false;
  #primary = false;
  #capsLock = false;
  /** The brush HUD gesture in progress. */
  #adjusting: { tool: Tool; pointerId: number } | null = null;
  /** Last hover position (re-sent when Caps Lock changes the cursor). */
  #lastHover: ToolPointerEvent | null = null;
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
    this.#listen(el, 'contextmenu', (e) => e.preventDefault());
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
    const ctx = this.#o.context;
    const active = this.#o.tools.byId.get(this.#o.getActiveToolId()) ?? null;
    if (this.#activeTool !== active) {
      if (this.#activeTool) {
        this.#activeTool.cancel?.(ctx);
        this.#activeTool.deactivate?.(ctx);
      }
      this.#activeTool = active;
      if (ctx.document) active?.activate?.(ctx);
    }
    this.#updateCursor();
  }

  /** Abandons whatever the active tool is in the middle of (e.g. the document changed); `refresh` restarts it. */
  cancelTool(): void {
    this.#cancelDrag();
    this.#activeTool?.cancel?.(this.#o.context);
    this.#activeTool?.deactivate?.(this.#o.context);
    this.#activeTool = null;
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

  #toolEvent(e: MouseEvent, predicted?: PointerEvent): ToolPointerEvent {
    const rect = this.#o.element.getBoundingClientRect();
    const dpr = this.#o.devicePixelRatio();
    const pe = 'pointerType' in e ? (e as PointerEvent) : null;
    const pen = pe?.pointerType === 'pen';
    const [tiltX, tiltY] = pen ? penTilt(pe) : [0, 0];
    return {
      x: (e.clientX - rect.left) * dpr,
      y: (e.clientY - rect.top) * dpr,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      primaryKey: isMac ? e.metaKey : e.ctrlKey,
      spaceKey: this.#space,
      pressure: pen ? pe.pressure : 1,
      tiltX,
      tiltY,
      twist: pen ? pe.twist : 0,
      // The stylus wheel arrives as tangential pressure (−1–1); its resting position is 0.
      wheel: pen ? Math.min(1, Math.max(0, pe.tangentialPressure)) : 0,
      time: e.timeStamp,
      capsLock: e.getModifierState?.('CapsLock') ?? false,
      pointerType: pe?.pointerType === 'pen' || pe?.pointerType === 'touch' ? pe.pointerType : 'mouse',
      ...(predicted
        ? { predicted: { x: (predicted.clientX - rect.left) * dpr, y: (predicted.clientY - rect.top) * dpr } }
        : {}),
    };
  }

  /** Alt+right-press, or Ctrl+Option-press on macOS, on a tool with a brush. */
  #startAdjust(e: PointerEvent): boolean {
    const gesture = isMac ? e.button === 0 && e.ctrlKey && e.altKey : e.button === 2 && e.altKey;
    const tool = this.currentTool;
    if (!gesture || !tool.adjustBrush || !this.#o.context.document || this.#dragTool || this.#adjusting) return false;
    e.preventDefault();
    if (!tool.adjustBrush.begin(this.#toolEvent(e), this.#o.context)) return false;
    try {
      this.#o.element.setPointerCapture(e.pointerId);
    } catch {
      // Already gone: the gesture still works without capture.
    }
    this.#adjusting = { tool, pointerId: e.pointerId };
    return true;
  }

  readonly #onPointerDown = (e: PointerEvent) => {
    if (this.#startAdjust(e)) return;
    if (e.button !== 0 || this.#dragTool || this.#adjusting) return;
    e.preventDefault();
    this.#o.element.focus({ preventScroll: true });
    try {
      this.#o.element.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone (e.g. a pen lifted at once): the drag still works without capture.
    }
    this.#pointerId = e.pointerId;
    this.#dragTool = this.currentTool;
    this.#o.onGestureStart?.();
    this.#dragTool.onPointerDown?.(this.#toolEvent(e), this.#o.context);
    this.#updateCursor();
  };

  readonly #onPointerMove = (e: PointerEvent) => {
    if (this.#adjusting) {
      if (e.pointerId === this.#adjusting.pointerId)
        this.#adjusting.tool.adjustBrush!.move(this.#toolEvent(e), this.#o.context);
      return;
    }
    if (this.#dragTool && e.pointerId === this.#pointerId) {
      // Coalesced events give every intermediate position for smooth drags; the last one
      // carries where the pointer is predicted to go (for drawing the cursor ahead).
      const coalesced = e.getCoalescedEvents?.() ?? [];
      const events = coalesced.length > 0 ? coalesced : [e];
      const predicted = e.getPredictedEvents?.().at(-1);
      events.forEach((ev, i) => {
        this.#lastMove = this.#toolEvent(ev, i === events.length - 1 ? predicted : undefined);
        this.#dragTool!.onPointerMove?.(this.#lastMove, this.#o.context);
      });
    } else if (!this.#dragTool && this.#o.context.document) {
      this.#lastHover = this.#toolEvent(e, e.getPredictedEvents?.().at(-1));
      this.currentTool.onPointerHover?.(this.#lastHover, this.#o.context);
      this.#updateCursor(); // the cursor may depend on what is under the pointer (crop handles)
    }
    this.#syncModifiers(e);
  };

  #endAdjust(): void {
    const adjusting = this.#adjusting;
    if (!adjusting) return;
    this.#adjusting = null;
    if (this.#o.element.hasPointerCapture(adjusting.pointerId))
      this.#o.element.releasePointerCapture(adjusting.pointerId);
    adjusting.tool.adjustBrush!.end(this.#o.context);
  }

  readonly #onPointerUp = (e: PointerEvent) => {
    if (this.#adjusting && e.pointerId === this.#adjusting.pointerId) {
      this.#endAdjust();
      return;
    }
    if (!this.#dragTool || e.pointerId !== this.#pointerId) return;
    const tool = this.#dragTool;
    this.#dragTool = null;
    this.#pointerId = null;
    this.#lastMove = null;
    tool.onPointerUp?.(this.#toolEvent(e), this.#o.context);
    this.#updateCursor();
  };

  readonly #onPointerCancel = () => {
    this.#endAdjust();
    this.#cancelDrag();
  };

  readonly #onPointerLeave = () => {
    this.#lastHover = null;
    if (!this.#dragTool && !this.#adjusting) this.currentTool.onPointerLeave?.(this.#o.context);
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
    this.#endAdjust();
    this.#cancelDrag();
  };

  #syncModifiers(e: KeyboardEvent | MouseEvent): void {
    const primary = isMac ? e.metaKey : e.ctrlKey;
    const caps = e.getModifierState?.('CapsLock') ?? false;
    if (caps !== this.#capsLock) {
      this.#capsLock = caps;
      // The painting cursor changes at once, without moving the pointer.
      const hover = this.#lastHover;
      if (hover && !this.#dragTool && !this.#adjusting) {
        this.#lastHover = { ...hover, capsLock: caps };
        this.currentTool.onPointerHover?.(this.#lastHover, this.#o.context);
      }
      this.#updateCursor();
    }
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
    const paintCursor = effectivePaintCursor(this.#o.context.cursorPreferences.painting, this.#capsLock);
    this.#o.element.style.cursor = this.#o.context.document
      ? tool.cursor({ altKey: this.#alt, dragging: !!this.#dragTool, paintCursor })
      : 'default';
  }
}
