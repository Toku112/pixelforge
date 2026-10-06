/** Minimal synchronous event emitter (the core cannot use DOM EventTarget). */
export class Emitter<T> {
  readonly #listeners = new Set<(event: T) => void>();

  on(listener: (event: T) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: T): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}
