/**
 * Eyedropper tool (I).
 *
 * Behaviour (own summary of the reference app):
 * - Click (or drag) on the image: the colour there becomes the foreground colour;
 *   with Alt/Option, the background colour.
 * - Options: Sample Size (the pixel, or the average of 3 × 3 … 101 × 101), Sample
 *   (current layer, current and below, all layers) and Show Sampling Ring (while
 *   sampling, a ring shows the new colour over the current one).
 */
import { DEFAULT_EYEDROPPER, type EyedropperOptions } from '../../core/paint/sample';
import { EYEDROPPER_CURSOR } from '../paint/cursors';
import type { CursorState, Tool, ToolContext, ToolPointerEvent } from '../types';
import { ColorSampler } from './sampler';

export class EyedropperTool implements Tool {
  readonly id = 'eyedropper';
  readonly name = 'Eyedropper Tool';
  readonly key = 'I';
  readonly options: EyedropperOptions = { ...DEFAULT_EYEDROPPER };
  readonly #sampler = new ColorSampler();

  setOptions(changes: Partial<EyedropperOptions>): void {
    Object.assign(this.options, changes);
  }

  cursor(_state: CursorState): string {
    return EYEDROPPER_CURSOR;
  }

  busy(): boolean {
    return this.#sampler.active;
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    this.#sampler.begin(e, ctx, e.altKey ? 'background' : 'foreground');
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.#sampler.move(e, ctx);
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    this.#sampler.end(e, ctx);
  }

  cancel(ctx: ToolContext): void {
    this.#sampler.cancel(ctx);
  }
}
