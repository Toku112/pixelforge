/**
 * Hand tool (H; hold Space for it temporarily): drag to move the view.
 * Options bar actions: 100 %, Fit Screen, Fill Screen.
 */
import type { Point } from '../../engine/viewport/viewport';
import type { CursorState, Tool, ToolContext, ToolPointerEvent } from '../types';

export class HandTool implements Tool {
  readonly id = 'hand';
  readonly name = 'Hand Tool';
  readonly key = 'H';
  #last: Point | null = null;

  cursor({ dragging }: CursorState): string {
    return dragging ? 'grabbing' : 'grab';
  }

  onPointerDown(e: ToolPointerEvent): void {
    this.#last = { x: e.x, y: e.y };
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!this.#last) return;
    ctx.viewport.panBy(e.x - this.#last.x, e.y - this.#last.y);
    this.#last = { x: e.x, y: e.y };
    ctx.viewChanged();
  }

  onPointerUp(): void {
    this.#last = null;
  }

  cancel(): void {
    this.#last = null;
  }
}

/** Shared view commands used by the Hand and Zoom options bars and the View menu. */
export const viewActions = {
  actualPixels(ctx: ToolContext): void {
    if (!ctx.document) return;
    ctx.viewport.zoomTo(1);
    ctx.viewChanged();
  },
  fitOnScreen(ctx: ToolContext, margin = 24): void {
    if (!ctx.document) return;
    ctx.viewport.fit(ctx.document.width, ctx.document.height, margin);
    ctx.viewChanged();
  },
  fillScreen(ctx: ToolContext): void {
    if (!ctx.document) return;
    ctx.viewport.fill(ctx.document.width, ctx.document.height);
    ctx.viewChanged();
  },
};
