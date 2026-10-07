/**
 * The foreground and background colours (the toolbar swatches). Black and white
 * by default; D restores that, X swaps them. They belong to the app, not to a
 * document, as in the reference app.
 */
import { BLACK, WHITE, sameColor, type RGB } from '../core/color/color';
import { Emitter } from '../core/document/events';

export class ColorSwatches {
  readonly changes = new Emitter<void>();
  #foreground: RGB = BLACK;
  #background: RGB = WHITE;
  #version = 0;

  get foreground(): RGB {
    return this.#foreground;
  }

  get background(): RGB {
    return this.#background;
  }

  /** Increases on every change (for UI subscriptions). */
  get version(): number {
    return this.#version;
  }

  setForeground(color: RGB): void {
    if (sameColor(color, this.#foreground)) return;
    this.#foreground = Object.freeze({ ...color });
    this.#changed();
  }

  setBackground(color: RGB): void {
    if (sameColor(color, this.#background)) return;
    this.#background = Object.freeze({ ...color });
    this.#changed();
  }

  /** X: exchanges the foreground and background colours. */
  swap(): void {
    [this.#foreground, this.#background] = [this.#background, this.#foreground];
    this.#changed();
  }

  /** D: black foreground, white background. */
  reset(): void {
    this.#foreground = BLACK;
    this.#background = WHITE;
    this.#changed();
  }

  #changed(): void {
    this.#version++;
    this.changes.emit();
  }
}
