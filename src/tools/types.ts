/**
 * Tool framework. Tools are UI-agnostic: they receive pointer events in canvas
 * device pixels and act on the document view and the document (through commands)
 * via a context. The UI layer turns DOM events into these calls and draws overlays.
 */
import type { CommandDescriptor } from '../core/commands/command';
import type { ImageDocument } from '../core/document/document';
import type { SelectionShape } from '../core/selection/mask-ops';
import type { Viewport } from '../engine/viewport/viewport';

export interface ToolPointerEvent {
  /** Canvas position in device pixels. */
  x: number;
  y: number;
  shiftKey: boolean;
  altKey: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  primaryKey: boolean;
  /** Space is held (selection tools: reposition the shape being drawn). */
  spaceKey: boolean;
}

export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a selection tool shows while it is used (document coordinates). */
export type SelectionPreview =
  /** The shape being drawn; `hideCurrent` hides the current selection (a new one replaces it). */
  | { kind: 'shape'; shape: SelectionShape; closed: boolean; hideCurrent: boolean }
  /** The current selection outline being dragged to a new place. */
  | { kind: 'move'; dx: number; dy: number };

export interface ToolContext {
  readonly viewport: Viewport;
  readonly document: ImageDocument | null;
  /** Device pixels per CSS pixel; gesture distances are judged in CSS pixels. */
  readonly devicePixelRatio: number;
  /** Re-applies view limits and schedules a frame. Call after changing the view. */
  viewChanged(): void;
  /** Shows a rectangle overlay on the canvas (view pixels), or hides it with null. */
  setOverlayRect(rect: ViewRect | null): void;
  /** Shows what a selection tool is drawing or moving, or hides it with null. */
  setSelectionPreview(preview: SelectionPreview | null): void;
  /** Runs a document command through the History (problems are reported to the user). */
  execute(descriptor: CommandDescriptor): void;
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
  /** Pointer moves while no button is pressed (e.g. the polygonal lasso's next segment). */
  onPointerHover?(e: ToolPointerEvent, ctx: ToolContext): void;
  /** A key pressed over the canvas (Enter, Escape, Backspace…); true when the tool used it. */
  onKeyDown?(key: string, ctx: ToolContext): boolean;
  /** True while the tool is in the middle of something spanning several clicks. */
  busy?(): boolean;
  /** Called when the pointer gesture is abandoned (e.g. Escape or tool switch). */
  cancel?(ctx: ToolContext): void;
}
