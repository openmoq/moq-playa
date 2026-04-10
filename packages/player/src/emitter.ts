/**
 * Typed event emitter — strongly typed, zero dependencies.
 *
 * Wraps Map<string, Set<Function>> with generic type safety.
 * Used by MoqtPlayer to emit PlayerEvents to application code.
 *
 * @module
 */

/**
 * A typed event emitter.
 *
 * @typeParam M - Event map: `{ eventName: eventDataType }`
 */
export class TypedEmitter<M> {
  private readonly listeners = new Map<keyof M, Set<Function>>();

  /**
   * Register a listener for an event.
   * @returns Unsubscribe function.
   */
  on<K extends keyof M>(event: K, fn: (data: M[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => { set.delete(fn); };
  }

  /** Remove a specific listener. */
  off<K extends keyof M>(event: K, fn: (data: M[K]) => void): void {
    this.listeners.get(event)?.delete(fn);
  }

  /** Emit an event to all registered listeners. */
  emit<K extends keyof M>(event: K, data: M[K]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const fn of set) {
        fn(data);
      }
    }
  }

  /** Remove all listeners for all events. */
  removeAllListeners(): void {
    this.listeners.clear();
  }
}
