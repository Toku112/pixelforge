/**
 * Rotate View tool (R): drag to rotate the view of the canvas around the centre of
 * the window (the document itself is not changed). Shift snaps to 15° steps.
 * Options bar: rotation angle field and Reset View.
 */
import { normalizeAngle } from '../../engine/viewport/viewport';
import type { Tool, ToolContext, ToolPointerEvent } from '../types';

export const ROTATE_SNAP_DEGREES = 15;

export class RotateViewTool implements Tool {
  readonly id = 'rotate-view';
  readonly name = 'Rotate View Tool';
  readonly key = 'R';
  #startPointerAngle = 0;
  #startRotation = 0;
  #active = false;

  cursor(): string {
    return 'grab';
  }

  #pointerAngle(e: ToolPointerEvent, ctx: ToolContext): number {
    const v = ctx.viewport;
    return (Math.atan2(e.y - v.viewHeight / 2, e.x - v.viewWidth / 2) * 180) / Math.PI;
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    this.#active = true;
    this.#startPointerAngle = this.#pointerAngle(e, ctx);
    this.#startRotation = ctx.viewport.rotation;
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!this.#active) return;
    let angle = this.#startRotation + this.#pointerAngle(e, ctx) - this.#startPointerAngle;
    if (e.shiftKey) angle = Math.round(angle / ROTATE_SNAP_DEGREES) * ROTATE_SNAP_DEGREES;
    ctx.viewport.rotateTo(normalizeAngle(angle));
    ctx.viewChanged();
  }

  onPointerUp(): void {
    this.#active = false;
  }

  cancel(ctx: ToolContext): void {
    if (!this.#active) return;
    this.#active = false;
    ctx.viewport.rotateTo(this.#startRotation);
    ctx.viewChanged();
  }
}

export function resetView(ctx: ToolContext): void {
  ctx.viewport.rotateTo(0);
  ctx.viewChanged();
}

export function setViewRotation(ctx: ToolContext, degrees: number): void {
  ctx.viewport.rotateTo(normalizeAngle(degrees));
  ctx.viewChanged();
}
