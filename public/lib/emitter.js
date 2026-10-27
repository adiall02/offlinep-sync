/** Minimal event emitter — the framework-free stand-in for Angular signals. */
export class Emitter {
  #listeners = new Map();

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.#listeners.get(event).delete(fn);
  }

  emit(event, payload) {
    for (const fn of this.#listeners.get(event) ?? []) fn(payload);
  }
}
