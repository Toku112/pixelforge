/**
 * Tool framework. Tools are UI-agnostic: they receive pointer events in canvas
 * device pixels and act on the document view and the document (through commands)
 * via a context. The UI layer turns DOM events into these calls and draws overlays.
 */
import type { PaintTool } from '../core/commands/builtin/paint';
import type { CommandDescriptor } from '../core/commands/command';
import type { BrushSettings, Dab, StrokePoint } from '../core/paint/brush';
import type { DynamicsColors } from '../core/paint/dynamics';
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
  /** Pen pressure 0–1 (1 for a mouse or touch). */
  pressure: number;
  /** Pen tilt along x and y, degrees (−90–90; 0 upright or no pen). */
  tiltX?: number;
  tiltY?: number;
  /** Pen barrel rotation, degrees (0–359). */
  twist?: number;
  /** Stylus wheel (airbrush finger wheel), 0–1. */
  wheel?: number;
  /** Event time, ms (for timing within a stroke). */
  time?: number;
  pointerType?: 'mouse' | 'pen' | 'touch';
  /** Where the pointer is predicted to be next (canvas device px), for drawing the cursor ahead. */
  predicted?: { x: number; y: number };
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

/** The Crop tool's box: `rect` in document pixels, or null for the whole canvas; `thirds` shows the grid. */
export interface CropBoxOverlay {
  rect: { x: number; y: number; w: number; h: number } | null;
  thirds: boolean;
}

/** The brush cursor: centre and size (document px) and the tip's pose; `tip` names a sampled tip. */
export interface BrushOutline {
  x: number;
  y: number;
  size: number;
  angle?: number;
  roundness?: number;
  flipX?: boolean;
  flipY?: boolean;
  tip?: string | null;
}

/** Free Transform's box (document coordinates): its corners, the 8 handles and the reference point (if shown). */
export interface TransformBoxOverlay {
  quad: readonly { x: number; y: number }[];
  handles: readonly { x: number; y: number }[];
  reference: { x: number; y: number } | null;
}

/** A brush/eraser stroke in progress (see app/paint-session.ts). */
export interface PaintStroke {
  /** Seeds the stroke's dynamics (recorded, so a replay paints the same dabs). */
  readonly seed: number;
  /** The colours Color Dynamics vary between, or null. */
  readonly colors: DynamicsColors | null;
  add(dabs: Dab[]): void;
  /** Ends the stroke (one History step); `points` are its pointer samples, for Actions. */
  end(points: StrokePoint[]): Promise<void>;
  cancel(): Promise<void>;
}

/** Starts strokes on the active layer; null (after telling the user why) when it cannot be painted. */
export interface PaintHost {
  begin(tool: PaintTool, brush: BrushSettings): PaintStroke | null;
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
  /** Shows what a selection tool is drawing or moving, or hides it with null. */
  setSelectionPreview(preview: SelectionPreview | null): void;
  /** Runs a document command through the History (problems are reported to the user). */
  execute(descriptor: CommandDescriptor): void;
  /** Painting (Brush, Eraser); null where painting is not set up (e.g. in tests). */
  readonly paint: PaintHost | null;
  /** Shows the Crop tool's box, or hides it with null. */
  setCropBox(box: CropBoxOverlay | null): void;
  /** Shows Free Transform's box, or hides it with null. */
  setTransformBox(box: TransformBoxOverlay | null): void;
  /** Shows the brush outline at a document point (diameter in document px, tip pose), or hides it. */
  setBrushOutline(outline: BrushOutline | null): void;
  /** Shows a command's result live without recording it (null cancels); `execute` then records it. */
  preview(descriptor: CommandDescriptor | null): void;
  /** Selects layers of the document (e.g. the Move tool's Auto-Select). */
  selectLayers(ids: string[]): void;
  /** Tells the user why something cannot be done. */
  report(title: string, message: string): void;
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
  /** The pointer left the canvas. */
  onPointerLeave?(ctx: ToolContext): void;
  /** A key pressed over the canvas (Enter, Escape, Backspace…); true when the tool used it. */
  onKeyDown?(key: string, ctx: ToolContext): boolean;
  /** True while the tool is in the middle of something spanning several clicks. */
  busy?(): boolean;
  /** Called when the pointer gesture is abandoned (e.g. Escape or tool switch). */
  cancel?(ctx: ToolContext): void;
  /** The tool was chosen (or another document is shown while it is active). */
  activate?(ctx: ToolContext): void;
  /** Another tool was chosen (or the document goes away): hide what the tool shows. */
  deactivate?(ctx: ToolContext): void;
}
