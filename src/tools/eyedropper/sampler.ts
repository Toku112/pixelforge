/**
 * Picking a colour off the canvas while the pointer is down (the Eyedropper, and
 * Alt with the Brush): the colour under the pointer becomes the foreground (with Alt
 * on the Eyedropper, the background) as the pointer moves, and the sampling ring
 * shows the new colour over the one it replaces.
 */
import type { RGB } from '../../core/color/color';
import type { ToolContext, ToolPointerEvent } from '../types';

export class ColorSampler {
  #which: 'foreground' | 'background' = 'foreground';
  #before: RGB | null = null;
  /** A sample is on its way; the latest position waits for it. */
  #busy = false;
  #next: { x: number; y: number } | null = null;
  #active = false;

  get active(): boolean {
    return this.#active;
  }

  begin(e: ToolPointerEvent, ctx: ToolContext, which: 'foreground' | 'background'): void {
    const colors = ctx.colors;
    if (!colors || !ctx.document) return;
    this.#active = true;
    this.#which = which;
    this.#before = colors.get(which);
    this.move(e, ctx);
  }

  move(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!this.#active) return;
    this.#next = ctx.viewport.viewToDoc({ x: e.x, y: e.y });
    if (!this.#busy) void this.#sample(ctx);
  }

  end(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!this.#active) return;
    this.move(e, ctx);
    this.#active = false;
    if (!this.#busy) ctx.setSampleRing(null);
  }

  cancel(ctx: ToolContext): void {
    if (!this.#active) return;
    this.#active = false;
    this.#next = null;
    if (this.#before) ctx.colors?.set(this.#which, this.#before);
    ctx.setSampleRing(null);
  }

  async #sample(ctx: ToolContext): Promise<void> {
    const colors = ctx.colors;
    if (!colors) return;
    this.#busy = true;
    try {
      while (this.#next) {
        const at = this.#next;
        this.#next = null;
        const color = await colors.sample(at.x, at.y, colors.eyedropper);
        if (color) colors.set(this.#which, color);
        if (this.#active && colors.eyedropper.showRing && this.#before)
          ctx.setSampleRing({ x: at.x, y: at.y, now: color ?? colors.get(this.#which), before: this.#before });
      }
    } finally {
      this.#busy = false;
      if (!this.#active) ctx.setSampleRing(null);
    }
  }
}
