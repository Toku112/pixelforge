/**
 * Tool framework. Tools are UI-agnostic: they receive pointer events in canvas
 * device pixels and act on the document view (and later the document) through a
 * context. The UI layer turns DOM events into these calls and draws overlays.
 */
import type { ImageDocument } from '../core/document/document';
import type { Viewport } from '../engine/viewport/viewport';

export interface ToolPointerEvent {
  /** Canvas position in device pixels. */
  x: number;
  y: number;
  shiftKey: boolean;
  altKey: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  primaryKey: boolean;
}

export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ToolContext {
  readonly viewport: Viewport;
  readonly document: ImageDocument | null;
  /** Device pixels per CSS pixel; gesture distances are judged in CSS pixels. */
  readonly devicePixelRatio: number;
  /** Re-applies view limits and schedules a frame. Call after changing the view. */
  viewChanged(): void;
  /** Shows a rectangle overlay on the canvas (view pixels), or hides it with null. */
  setOverlayRect(rect: ViewRect | null): void;
}

/** Modifier and drag state that decides a tool's cursor. */
export interface CursorState {
  altKey: boolean;
  dragging: boolean;
}

export interface Tool {
  readonly id: string;
  readonly name: string;
  /** Single-letter default shortcut. */
  readonly key: string;
  /** CSS cursor for the current modifier state. */
  cursor(state: CursorState): string;
  onPointerDown?(e: ToolPointerEvent, ctx: ToolContext): void;
  onPointerMove?(e: ToolPointerEvent, ctx: ToolContext): void;
  onPointerUp?(e: ToolPointerEvent, ctx: ToolContext): void;
  /** Called when the pointer gesture is abandoned (e.g. Escape or tool switch). */
  cancel?(ctx: ToolContext): void;
}
